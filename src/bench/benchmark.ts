/**
 * FairPR benchmark: run the checks on real, already-closed pull requests and
 * measure how the verdicts line up with what maintainers actually did.
 *
 *   GITHUB_TOKEN=... npm run bench -- --repos godotengine/godot,curl/curl --per-repo 100
 *
 * Only reads public data. Results are appended to bench-results/results.jsonl,
 * so an interrupted run continues where it stopped.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getOctokit } from '@actions/github';
import { DEFAULT_POLICY, type Policy } from '../policy';
import { evaluate } from '../engine';
import { loadManifests } from '../manifests';
import { apiReader } from '../github';
import type { ChangedFile, PrContext } from '../types';
import { writeReport, type BenchRecord, type Group } from './report';

type Octokit = ReturnType<typeof getOctokit>;

export const DEFAULT_REPOS = [
  'godotengine/godot',
  'curl/curl',
  'ghostty-org/ghostty',
  'excalidraw/excalidraw',
  'n8n-io/n8n',
  'langchain-ai/langchain',
  'vercel/next.js',
  'microsoft/vscode',
  'home-assistant/core',
  'facebook/react',
];

const FIRST_TIME = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']);
const LOW_QUALITY_LABEL = /spam|invalid|slop|ai[\s_-]*generated|low[\s_-]*(quality|effort)|llm|automated/i;

interface Options {
  repos: string[];
  perRepo: number;
  since: string;
  out: string;
  reportOnly: boolean;
  /** Re-measure already-saved PRs that have this finding (after a check was improved). */
  remeasure?: string;
  /** Scan repositories again even if a previous run searched them completely. */
  rescan: boolean;
}

export function parseBenchArgs(argv: string[]): Options {
  const o: Options = { repos: DEFAULT_REPOS, perRepo: 100, since: '2025-06-01', out: 'bench-results', reportOnly: false, rescan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--repos') o.repos = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--per-repo') o.perRepo = Math.max(1, parseInt(v(), 10) || 100);
    else if (a === '--since') o.since = v();
    else if (a === '--out') o.out = v();
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--remeasure') o.remeasure = v();
    else if (a === '--rescan') o.rescan = true;
    else throw new Error(`Unknown option ${a}`);
  }
  for (const r of o.repos) if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`Bad repo "${r}" (use owner/name)`);
  if (Number.isNaN(Date.parse(o.since))) throw new Error('--since must be a date like 2025-06-01');
  return o;
}

/** The benchmark measures code and behaviour signals, not each repo's own rules. */
export const BENCH_POLICY: Policy = {
  ...structuredClone(DEFAULT_POLICY),
  ai_policy: 'allowed', // projects without a disclosure rule must not be "failed" for missing it
  skip_maintainers: true,
  skip_returning_contributors: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps us well under GitHub's limits: waits when the budget is low, retries secondary limits. */
function installRateLimiter(octokit: Octokit, log: (s: string) => void) {
  let remaining = 5000;
  let reset = 0;
  octokit.hook.before('request', async () => {
    if (remaining < 60 && reset * 1000 > Date.now()) {
      const wait = reset * 1000 - Date.now() + 2000;
      log(`  rate limit nearly used; waiting ${Math.ceil(wait / 60000)} min…`);
      await sleep(wait);
      remaining = 5000;
    }
  });
  octokit.hook.after('request', (res) => {
    const h = res.headers as Record<string, string | undefined>;
    // GitHub has separate budgets ("core" 5000/h, "search" 30/min, ...). Only "core" is used
    // by the benchmark, so only it is tracked.
    const resource = h['x-ratelimit-resource'] ?? 'core';
    if (resource !== 'core') return;
    if (h['x-ratelimit-remaining']) remaining = Number(h['x-ratelimit-remaining']);
    if (h['x-ratelimit-reset']) reset = Number(h['x-ratelimit-reset']);
  });
  octokit.hook.error('request', async (error, options) => {
    const e = error as { status?: number; response?: { headers?: Record<string, string> } };
    const retryAfter = Number(e.response?.headers?.['retry-after'] ?? 0);
    if ((e.status === 403 || e.status === 429) && (retryAfter || e.response?.headers?.['x-ratelimit-remaining'] === '0')) {
      const wait = retryAfter ? retryAfter * 1000 : Math.max(0, Number(e.response?.headers?.['x-ratelimit-reset'] ?? 0) * 1000 - Date.now()) + 2000;
      log(`  GitHub asked us to slow down; waiting ${Math.ceil(wait / 1000)} s…`);
      await sleep(wait);
      return octokit.request(options as any);
    }
    if (e.status && e.status >= 500) {
      await sleep(3000);
      return octokit.request(options as any);
    }
    throw error;
  });
}

/**
 * True if `login` had no commit on the default branch before `mergedAt`, i.e. this merged PR
 * was their first contribution. Uses the commits API (normal budget; works with fine-grained
 * tokens, unlike the search API).
 */
async function isFirstMerged(octokit: Octokit, repo: string, login: string, mergedAt: string, log: (s: string) => void): Promise<boolean> {
  const [owner, name] = repo.split('/');
  try {
    // The PR's own commits land at merge time, so only look at commits from before the merge.
    const until = new Date(Date.parse(mergedAt) - 2 * 60 * 1000).toISOString();
    const res = await octokit.rest.repos.listCommits({ owner, repo: name, author: login, until, per_page: 1 });
    return res.data.length === 0;
  } catch (e) {
    log(`  could not check history for @${login} (${(e as Error).message}); not counting this PR`);
    return false;
  }
}

function loadDone(file: string): Map<string, BenchRecord> {
  const done = new Map<string, BenchRecord>();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as BenchRecord;
      done.set(`${r.repo}#${r.number}`, r);
    } catch {
      /* ignore a half-written last line */
    }
  }
  return done;
}

interface RepoState {
  finished: 'quota' | 'no-older-prs' | 'no-more-prs' | 'page-limit' | 'error';
  at: string;
  stats: Record<string, number>;
}

function loadState(file: string): Record<string, RepoState> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const groupOf = (labels: string[], merged: boolean): Group =>
  labels.some((l) => LOW_QUALITY_LABEL.test(l)) ? 'labeled-low-quality' : merged ? 'merged' : 'closed-unmerged';

type PullLike = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  merged_at: string | null;
  labels?: ({ name?: string } | string)[];
  user: { login: string } | null;
  head: { sha: string };
};

/** Run FairPR on one PR exactly like the Action would and return the record. */
async function measure(octokit: Octokit, full: string, pr: PullLike, ageCache: Map<string, number | undefined>): Promise<BenchRecord> {
  const [owner, repo] = full.split('/');
  const r = { owner, repo };
  const login = pr.user?.login ?? 'ghost';
  const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
  const rawFiles = await octokit.paginate(octokit.rest.pulls.listFiles, { ...r, pull_number: pr.number, per_page: 100 }, (res, stop) => {
    if (res.data.length < 100) stop();
    return res.data;
  });
  const files: ChangedFile[] = rawFiles.slice(0, 300).map((f) => ({
    filename: f.filename,
    status: f.status as ChangedFile['status'],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    sha: f.status === 'removed' ? undefined : f.sha,
  }));
  if (!ageCache.has(login)) {
    try {
      const { data: u } = await octokit.rest.users.getByUsername({ username: login });
      ageCache.set(login, Math.floor((Date.parse(pr.created_at) - Date.parse(u.created_at)) / 86_400_000));
    } catch {
      ageCache.set(login, undefined);
    }
  }
  let manifests = {};
  try {
    manifests = await loadManifests(apiReader(octokit, r, pr.head.sha), files);
  } catch {
    /* head commit may be gone; the import check is then skipped */
  }
  const ctx: PrContext = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    author: {
      login,
      accountAgeDays: ageCache.get(login),
      isBot: false,
      isFirstTimeContributor: true,
      isMaintainer: false,
      // Historical "PRs opened in 24h" cannot be reconstructed reliably, so the spray check is not measured.
      prsOpenedLast24h: undefined,
    },
    files,
    manifests,
  };
  const report = evaluate(ctx, BENCH_POLICY);
  return {
    repo: full,
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    group: groupOf(labels, !!pr.merged_at),
    labels,
    createdAt: pr.created_at,
    verdict: report.verdict,
    findings: report.findings.map((f) => ({ id: f.id, kind: f.kind, title: f.title, detail: f.detail.slice(0, 400) })),
    changedFiles: files.length,
  };
}

function saveAll(file: string, done: Map<string, BenchRecord>) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, [...done.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

export async function runBenchmark(octokit: Octokit, opts: Options, log: (s: string) => void = console.log): Promise<BenchRecord[]> {
  fs.mkdirSync(opts.out, { recursive: true });
  const file = path.join(opts.out, 'results.jsonl');
  const stateFile = path.join(opts.out, 'state.json');
  const done = loadDone(file);
  const state = loadState(stateFile);
  if (opts.reportOnly) return [...done.values()];

  try {
    await octokit.rest.rateLimit.get();
  } catch (e) {
    if ((e as { status?: number }).status === 401) {
      throw new Error('GitHub rejected the token ("Bad credentials"). Check GITHUB_TOKEN: no quotes, no spaces, the full github_pat_... value.');
    }
  }
  installRateLimiter(octokit, log);
  const ageCache = new Map<string, number | undefined>();

  // ---- re-measure saved PRs after a check was improved
  if (opts.remeasure) {
    const targets = [...done.values()].filter((x) => x.findings.some((f) => f.id === opts.remeasure) && opts.repos.includes(x.repo));
    log(`Re-measuring ${targets.length} saved PR(s) that had "${opts.remeasure}"…`);
    let changed = 0;
    for (const t of targets) {
      const [owner, repo] = t.repo.split('/');
      try {
        const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: t.number });
        const rec = await measure(octokit, t.repo, pr as PullLike, ageCache);
        rec.group = t.group; // keep the original sampling decision
        if (rec.verdict !== t.verdict || JSON.stringify(rec.findings) !== JSON.stringify(t.findings)) changed++;
        done.set(`${t.repo}#${t.number}`, rec);
      } catch (e) {
        log(`  could not re-measure ${t.repo}#${t.number}: ${(e as Error).message}`);
      }
    }
    saveAll(file, done);
    log(`Re-measured ${targets.length}; ${changed} result(s) changed.`);
    return [...done.values()];
  }

  const since = Date.parse(opts.since);
  for (const full of opts.repos) {
    const [owner, repo] = full.split('/');
    const r = { owner, repo };
    const mine = [...done.values()].filter((x) => x.repo === full);
    // Up to perRepo merged AND up to perRepo not-merged PRs, so both sides are measured fairly.
    let haveMerged = mine.filter((x) => x.group === 'merged').length;
    let haveOther = mine.length - haveMerged;
    const quotaFull = () => haveMerged >= opts.perRepo && haveOther >= opts.perRepo;
    if (quotaFull()) {
      log(`${full}: already have ${mine.length}, skipping`);
      continue;
    }
    if (state[full] && !opts.rescan && state[full].finished !== 'error') {
      log(`${full}: searched completely before (${state[full].finished}); skipping. Use --rescan to search again.`);
      continue;
    }
    log(`${full}: collecting first-time contributor PRs closed since ${opts.since}…`);

    // Why PRs were or were not measured, so the report can explain small samples.
    const stats: Record<string, number> = {
      listed: 0, measured: 0, already_measured: 0, bot: 0, draft: 0, quota_full: 0, returning_contributor: 0, maintainer: 0, error: 0,
    };
    let finished: RepoState['finished'] = 'page-limit';
    let page = 1;
    while (page <= 40) {
      if (quotaFull()) { finished = 'quota'; break; }
      let pulls;
      try {
        ({ data: pulls } = await octokit.rest.pulls.list({ ...r, state: 'closed', sort: 'created', direction: 'desc', per_page: 100, page }));
      } catch (e) {
        log(`  could not list PRs (${(e as Error).message}); skipping repo`);
        finished = 'error';
        break;
      }
      if (pulls.length === 0) { finished = 'no-more-prs'; break; }
      page++;
      let reachedOld = false;

      for (const pr of pulls) {
        if (quotaFull()) break;
        if (Date.parse(pr.created_at) < since) { reachedOld = true; break; }
        stats.listed++;
        const key = `${full}#${pr.number}`;
        if (done.has(key)) { stats.already_measured++; continue; }
        const login = pr.user?.login ?? 'ghost';
        if (pr.user?.type === 'Bot' || login.endsWith('[bot]')) { stats.bot++; continue; }
        if (pr.draft) { stats.draft++; continue; }
        const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
        const group = groupOf(labels, !!pr.merged_at);
        if (group === 'merged' ? haveMerged >= opts.perRepo : haveOther >= opts.perRepo) { stats.quota_full++; continue; }

        const assoc = pr.author_association;
        if (assoc === 'OWNER' || assoc === 'MEMBER' || assoc === 'COLLABORATOR') { stats.maintainer++; continue; }
        let firstTime = FIRST_TIME.has(assoc);
        // GitHub reports the author's CURRENT association: after their first PR is merged they
        // become a "CONTRIBUTOR". Count a merged PR as first-time if nothing of theirs was merged before it.
        if (!firstTime && assoc === 'CONTRIBUTOR' && pr.merged_at) {
          firstTime = await isFirstMerged(octokit, full, login, pr.merged_at, log);
        }
        if (!firstTime) { stats.returning_contributor++; continue; }

        try {
          const rec = await measure(octokit, full, pr as PullLike, ageCache);
          fs.appendFileSync(file, JSON.stringify(rec) + '\n');
          done.set(key, rec);
          stats.measured++;
          if (group === 'merged') haveMerged++;
          else haveOther++;
          if ((haveMerged + haveOther) % 10 === 0) log(`  merged ${haveMerged}/${opts.perRepo}, rejected ${haveOther}/${opts.perRepo}`);
        } catch (e) {
          stats.error++;
          log(`  skipped #${pr.number}: ${(e as Error).message}`);
        }
      }
      if (reachedOld) { finished = 'no-older-prs'; break; }
    }
    if (quotaFull()) finished = 'quota';
    log(`${full}: ${haveMerged} merged + ${haveOther} rejected PRs measured (${finished})`);
    log(`  looked at ${stats.listed} PRs: ${Object.entries(stats).filter(([k, v]) => k !== 'listed' && v > 0).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || 'none'}`);
    state[full] = { finished, at: new Date().toISOString(), stats };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
  return [...done.values()];
}

function resolveToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const out = require('child_process').execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function benchMain(argv = process.argv.slice(2)): Promise<number> {
  let opts: Options;
  try {
    opts = parseBenchArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const token = resolveToken();
  if (!token && !opts.reportOnly) {
    console.error('No GitHub token. Set GITHUB_TOKEN (a read-only token is enough) or log in with "gh auth login".');
    return 2;
  }
  const octokit = getOctokit(token ?? 'none', process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {});
  const started = Date.now();
  let records: BenchRecord[];
  try {
    records = await runBenchmark(octokit, opts);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const state = loadState(path.join(opts.out, 'state.json'));
  const reportPath = writeReport(records, opts.out, { repos: opts.repos, since: opts.since, policy: BENCH_POLICY, state });
  console.log(`\nMeasured ${records.length} PRs in ${Math.round((Date.now() - started) / 60000)} min.`);
  console.log(`Report: ${reportPath}`);
  return 0;
}


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
}

export function parseBenchArgs(argv: string[]): Options {
  const o: Options = { repos: DEFAULT_REPOS, perRepo: 100, since: '2025-06-01', out: 'bench-results', reportOnly: false };
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

let lastSearch = 0;
/** True if `login` had no merged PR in `repo` before `mergedAt`. Uses the search API (30 requests/min). */
async function isFirstMerged(octokit: Octokit, repo: string, login: string, mergedAt: string, log: (s: string) => void): Promise<boolean> {
  const wait = lastSearch + 2200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearch = Date.now();
  try {
    const before = new Date(Date.parse(mergedAt) - 1000).toISOString().slice(0, 19);
    const res = await octokit.rest.search.issuesAndPullRequests({ q: `repo:${repo} is:pr is:merged author:${login} merged:<${before}`, per_page: 1 });
    return res.data.total_count === 0;
  } catch (e) {
    log(`  search failed for @${login} (${(e as Error).message}); not counting this PR`);
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

export async function runBenchmark(octokit: Octokit, opts: Options, log: (s: string) => void = console.log): Promise<BenchRecord[]> {
  fs.mkdirSync(opts.out, { recursive: true });
  const file = path.join(opts.out, 'results.jsonl');
  const done = loadDone(file);
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
  const since = Date.parse(opts.since);

  for (const full of opts.repos) {
    const [owner, repo] = full.split('/');
    const r = { owner, repo };
    const mine = [...done.values()].filter((x) => x.repo === full);
    // Up to perRepo merged AND up to perRepo not-merged PRs, so both sides are measured fairly.
    let haveMerged = mine.filter((x) => x.group === 'merged').length;
    let haveOther = mine.length - haveMerged;
    const full_ = () => haveMerged >= opts.perRepo && haveOther >= opts.perRepo;
    if (full_()) {
      log(`${full}: already have ${mine.length}, skipping`);
      continue;
    }
    log(`${full}: collecting first-time contributor PRs closed since ${opts.since}…`);

    let page = 1;
    let reachedOld = false;
    while (!full_() && !reachedOld && page <= 40) {
      let pulls;
      try {
        ({ data: pulls } = await octokit.rest.pulls.list({ ...r, state: 'closed', sort: 'created', direction: 'desc', per_page: 100, page }));
      } catch (e) {
        log(`  could not list PRs (${(e as Error).message}); skipping repo`);
        break;
      }
      if (pulls.length === 0) break;
      page++;

      for (const pr of pulls) {
        if (full_()) break;
        if (Date.parse(pr.created_at) < since) { reachedOld = true; break; }
        const key = `${full}#${pr.number}`;
        if (done.has(key)) continue;
        const login = pr.user?.login ?? 'ghost';
        if (pr.user?.type === 'Bot' || login.endsWith('[bot]')) continue;
        if (pr.draft) continue;
        const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
        const group: Group = labels.some((l) => LOW_QUALITY_LABEL.test(l)) ? 'labeled-low-quality' : pr.merged_at ? 'merged' : 'closed-unmerged';
        if (group === 'merged' ? haveMerged >= opts.perRepo : haveOther >= opts.perRepo) continue;

        let firstTime = FIRST_TIME.has(pr.author_association);
        // GitHub reports the author's CURRENT association: after their first PR is merged they
        // become a "CONTRIBUTOR". Count a merged PR as first-time if nothing of theirs was merged before it.
        if (!firstTime && pr.author_association === 'CONTRIBUTOR' && pr.merged_at) {
          firstTime = await isFirstMerged(octokit, full, login, pr.merged_at, log);
        }
        if (!firstTime) continue;

        try {
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
            /* head commit may be gone; import check is then skipped */
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
          const rec: BenchRecord = {
            repo: full,
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            group,
            labels,
            createdAt: pr.created_at,
            verdict: report.verdict,
            findings: report.findings.map((f) => ({ id: f.id, kind: f.kind, title: f.title, detail: f.detail.slice(0, 400) })),
            changedFiles: files.length,
          };
          fs.appendFileSync(file, JSON.stringify(rec) + '\n');
          done.set(key, rec);
          if (group === 'merged') haveMerged++;
          else haveOther++;
          if ((haveMerged + haveOther) % 10 === 0) log(`  merged ${haveMerged}/${opts.perRepo}, rejected ${haveOther}/${opts.perRepo}`);
        } catch (e) {
          log(`  skipped #${pr.number}: ${(e as Error).message}`);
        }
      }
    }
    log(`${full}: ${haveMerged} merged + ${haveOther} rejected PRs measured`);
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
  const reportPath = writeReport(records, opts.out, { repos: opts.repos, since: opts.since, policy: BENCH_POLICY });
  console.log(`\nMeasured ${records.length} PRs in ${Math.round((Date.now() - started) / 60000)} min.`);
  console.log(`Report: ${reportPath}`);
  return 0;
}


import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { evaluate } from '../engine';
import { parsePolicy, PolicyError, type Policy } from '../policy';
import { loadManifests } from '../manifests';
import { fingerprint, proofMarker } from '../proof';
import { parseDisclosure } from '../checks';
import type { Finding, PrContext, Report } from '../types';
import {
  GitError, baseBranch, changedFiles, currentBranch, fetchBase, hasUncommittedChanges, lastCommitSubject,
  localReader, mergeBase, readAt, remoteRepo, repoRoot, targetRemote,
} from './git';

const VERSION = '0.3.2';

const HELP = `FairPR ${VERSION}: check your pull request against a project's contribution policy before you open it.

Usage:
  npx fairpr check [options]

Run it inside your clone, on the branch you want to submit. It:
  1. reads the project's rules (.github/fairpr.yml on the target branch)
  2. runs the same checks maintainers run on incoming PRs
  3. asks you three short questions so the description is in your own words
  4. runs the project's tests (if the project defines test_command)
  5. writes a PR description with a proof that matches this exact code

Options:
  --base <branch>      Target branch (default: the remote's default branch)
  --remote <name>      Remote of the project you contribute to (default: upstream, else origin)
  --title <text>       PR title (default: your last commit message)
  --problem <text>     What problem does this solve?
  --change <text>      What did you change?
  --tested <text>      How did you test it?
  --ai <yes|partial|no>  Did you use AI to write this change?
  --issue <number>     Issue this PR fixes
  --skip-tests         Do not run test_command
  --create             Open the PR with the GitHub CLI (gh) when all checks pass
  --yes                Never prompt; fail if an answer is missing (for scripts and agents)
  --json               Print a machine-readable result
  -h, --help           Show this help
  -v, --version        Show the version
`;

interface Args {
  cmd?: string;
  base?: string;
  remote?: string;
  title?: string;
  problem?: string;
  change?: string;
  tested?: string;
  ai?: string;
  issue?: string;
  skipTests: boolean;
  create: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { skipTests: false, create: false, yes: false, json: false, help: false, version: false };
  const valueFlags: Record<string, keyof Args> = {
    '--base': 'base', '--remote': 'remote', '--title': 'title', '--problem': 'problem', '--change': 'change',
    '--tested': 'tested', '--ai': 'ai', '--issue': 'issue',
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const [flag, inline] = t.startsWith('--') && t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined];
    if (flag in valueFlags) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value.`);
      (a as any)[valueFlags[flag]] = v;
    } else if (flag === '--skip-tests') a.skipTests = true;
    else if (flag === '--create') a.create = true;
    else if (flag === '--yes' || flag === '-y') a.yes = true;
    else if (flag === '--json') a.json = true;
    else if (flag === '-h' || flag === '--help') a.help = true;
    else if (flag === '-v' || flag === '--version') a.version = true;
    else if (!flag.startsWith('-') && !a.cmd) a.cmd = flag;
    else throw new UsageError(`Unknown option "${t}". Run "npx fairpr --help".`);
  }
  if (a.ai && !['yes', 'partial', 'no'].includes(a.ai.toLowerCase())) throw new UsageError('--ai must be yes, partial or no.');
  if (a.issue && !/^#?\d+$/.test(a.issue)) throw new UsageError('--issue must be a number, e.g. --issue 42.');
  return a;
}

class UsageError extends Error {}

// ------------------------------------------------------------------ output

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36);

function printFindings(findings: Finding[]) {
  for (const f of findings) {
    const tag = f.kind === 'hint' ? dim('note') : f.kind === 'signal' ? red('fix ') : yellow('fix ');
    console.log(`  ${tag}  ${bold(f.title)}`);
    console.log(`        ${f.detail.split('\n').join('\n        ')}`);
    console.log(`        ${cyan('→')} ${f.fix}`);
  }
}

// ------------------------------------------------------------------ description

const MIN_ANSWER = 15;

export function buildBody(o: {
  problem: string; change: string; tested: string; ai: string; issue?: string; testCommand?: string; proof?: string; checksPassed?: number;
}): string {
  const parts = [o.problem.trim(), '', o.change.trim(), '', '## How I tested it', '', o.tested.trim()];
  if (o.testCommand) parts.push('', `Ran \`${o.testCommand}\`: passed.`);
  if (o.issue) parts.push('', `Fixes #${o.issue.replace('#', '')}`);
  parts.push('', `AI-Assisted: ${o.ai}`);
  if (o.proof) {
    parts.push('', '---', proofMarker(o.proof), `🔏 Self-checked with [FairPR](https://github.com/fairpr/fairpr) v${VERSION}: ${o.checksPassed ?? 0} checks passed for this exact code.`);
  }
  return parts.join('\n') + '\n';
}

async function ask(rl: readline.Interface | undefined, question: string, opts: { min?: number; choices?: string[] } = {}): Promise<string> {
  if (!rl) throw new UsageError(`Missing answer for: ${question} (pass it as a flag, or run without --yes).`);
  for (;;) {
    const hint = opts.choices ? dim(` (${opts.choices.join('/')})`) : '';
    const answer = (await rl.question(`${bold('?')} ${question}${hint}\n${cyan('›')} `)).trim();
    if (opts.choices) {
      if (opts.choices.includes(answer.toLowerCase())) return answer.toLowerCase();
      console.log(yellow(`  Please answer ${opts.choices.join(', ')}.`));
      continue;
    }
    if (answer.length >= (opts.min ?? 1)) return answer;
    console.log(yellow(`  A bit more detail please (at least ${opts.min} characters). Write it in your own words.`));
  }
}

// ------------------------------------------------------------------ main flow

interface Result {
  ok: boolean;
  stage: 'checks' | 'tests' | 'done';
  report?: Report;
  bodyPath?: string;
  fingerprint?: string;
  prUrl?: string;
}

async function check(args: Args): Promise<Result> {
  const out = (s = '') => { if (!args.json) console.log(s); };
  const cwd = repoRoot();
  const remote = targetRemote(cwd, args.remote);
  const base = baseBranch(cwd, remote, args.base);
  const baseRef = `${remote}/${base}`;
  const branch = currentBranch(cwd);

  out(`${bold('FairPR')} ${dim(`v${VERSION}`)}: checking ${cyan(branch)} against ${cyan(baseRef)}`);
  if (!fetchBase(cwd, remote, base)) out(dim(`  (could not fetch ${baseRef}; using your local copy)`));
  if (branch === base) out(yellow(`  You are on "${base}". Contributions usually come from a separate branch.`));
  if (hasUncommittedChanges(cwd)) out(yellow('  You have uncommitted changes. Only committed code is checked and included in the PR.'));

  // Rules come from the TARGET branch, exactly like the maintainer-side Action.
  const { policy, warnings } = parsePolicy(readAt(cwd, baseRef, '.github/fairpr.yml'));
  warnings.forEach((w) => out(yellow(`  ${w}`)));
  if (!readAt(cwd, baseRef, '.github/fairpr.yml')) out(dim('  This project has no .github/fairpr.yml; using the default rules.'));

  const mb = mergeBase(cwd, baseRef);
  const files = changedFiles(cwd, mb);
  if (files.length === 0) throw new UsageError(`No committed changes compared to ${baseRef}. Commit your work first.`);
  const manifests = await loadManifests(localReader(cwd), files);

  out(dim(`  ${files.length} file(s) changed. AI contributions here: ${policy.ai_policy.replace(/_/g, ' ')}.`));
  if (policy.ai_policy === 'not_allowed') out(yellow('  ⚠ This project does not accept AI-generated contributions.'));
  out();

  // ---- questions
  const interactive = !args.yes && process.stdin.isTTY && !args.json;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const title = args.title ?? lastCommitSubject(cwd);
    const problem = args.problem ?? (await ask(rl, 'What problem does this change solve?', { min: MIN_ANSWER }));
    const change = args.change ?? (await ask(rl, 'What did you change, in your own words?', { min: MIN_ANSWER }));
    const tested = args.tested ?? (await ask(rl, 'How did you test it?', { min: MIN_ANSWER }));
    const ai = (args.ai ?? (await ask(rl, 'Did you use AI to write this change?', { choices: ['yes', 'partial', 'no'] }))).toLowerCase();
    let issue = args.issue;
    if (!issue && policy.require_linked_issue) issue = await ask(rl, 'Which issue number does this fix?', { min: 1 });
    rl?.close();

    const draftBody = buildBody({ problem, change, tested, ai, issue });
    const ctx: PrContext = {
      title,
      body: draftBody,
      // Assume the strictest case: maintainers see you as a first-time contributor.
      author: { login: 'you', isBot: false, isFirstTimeContributor: true, isMaintainer: false },
      files,
      manifests,
    };
    if (parseDisclosure(draftBody) === undefined) throw new Error('internal: disclosure line missing');

    const report = evaluate(ctx, policy);
    const blocking = report.findings.filter((f) => f.kind !== 'hint');
    const hints = report.findings.filter((f) => f.kind === 'hint');

    if (blocking.length) {
      out(red(bold(`✗ ${blocking.length} thing(s) to fix before opening this PR:`)));
      printFindings(blocking);
      if (hints.length) { out(); out(dim('Notes:')); printFindings(hints); }
      out();
      out(dim('Fix these, commit, and run `npx fairpr check` again.'));
      return { ok: false, stage: 'checks', report };
    }
    out(green(`✓ All ${report.passed.length} checks passed.`));
    if (hints.length) { out(dim('Notes (do not block):')); printFindings(hints); }

    // ---- tests
    let testCommand: string | undefined;
    if (policy.test_command && !args.skipTests) {
      out();
      out(`${bold('Running tests:')} ${policy.test_command}`);
      const r = spawnSync(policy.test_command, { cwd, shell: true, stdio: args.json ? 'ignore' : 'inherit' });
      if (r.status !== 0) {
        out(red(bold('✗ Tests failed. Fix them before opening the PR.')));
        return { ok: false, stage: 'tests', report };
      }
      out(green('✓ Tests passed.'));
      testCommand = policy.test_command;
    } else if (policy.test_command) {
      out(yellow(`  Skipped tests (${policy.test_command}). The description will not claim they passed.`));
    }

    // ---- proof + description
    const fp = fingerprint(files);
    const body = buildBody({ problem, change, tested, ai, issue, testCommand, proof: fp, checksPassed: report.passed.length });
    const dir = path.join(cwd, '.git', 'fairpr');
    fs.mkdirSync(dir, { recursive: true });
    const bodyPath = path.join(dir, 'PR_BODY.md');
    fs.writeFileSync(bodyPath, body);

    let prUrl: string | undefined;
    if (args.create) {
      const target = remoteRepo(cwd, remote);
      const ghArgs = ['pr', 'create', '--title', title, '--body-file', bodyPath, '--base', base];
      if (target) ghArgs.push('--repo', `${target.owner}/${target.repo}`);
      const r = spawnSync('gh', ghArgs, { cwd, encoding: 'utf8' });
      if (r.error) out(yellow('  GitHub CLI (gh) not found. Install it from https://cli.github.com or paste the description manually.'));
      else if (r.status !== 0) out(yellow(`  gh pr create failed: ${(r.stderr || '').trim()}`));
      else prUrl = r.stdout.trim().split('\n').pop();
    }

    out();
    if (prUrl) {
      out(green(bold(`✓ Pull request opened: ${prUrl}`)));
    } else {
      out(bold('Your PR description (saved to .git/fairpr/PR_BODY.md):'));
      out(dim('─'.repeat(60)));
      out(body.trimEnd());
      out(dim('─'.repeat(60)));
      out(`Paste it as the PR description, or open the PR with: ${cyan(`gh pr create --title ${JSON.stringify(title)} --body-file .git/fairpr/PR_BODY.md`)}`);
      out(dim('If you change the code after this, run the check again. The proof only matches this exact code.'));
    }
    return { ok: true, stage: 'done', report, bodyPath, fingerprint: fp, prUrl };
  } finally {
    rl?.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(red((e as Error).message));
    return 2;
  }
  if (args.version) { console.log(VERSION); return 0; }
  if (args.help || !args.cmd) { console.log(HELP); return args.cmd || args.help ? 0 : 2; }
  if (args.cmd !== 'check') { console.error(red(`Unknown command "${args.cmd}". Did you mean "npx fairpr check"?`)); return 2; }

  try {
    const result = await check(args);
    if (args.json) {
      console.log(JSON.stringify({
        ok: result.ok, stage: result.stage, verdict: result.report?.verdict,
        findings: result.report?.findings ?? [], passed: result.report?.passed ?? [],
        bodyPath: result.bodyPath, fingerprint: result.fingerprint, prUrl: result.prUrl,
      }, null, 2));
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    const msg = e instanceof GitError || e instanceof UsageError || e instanceof PolicyError ? (e as Error).message : `Unexpected error: ${(e as Error).stack}`;
    if (args.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(red(msg));
    return 2;
  }
}

// Re-exported for tests.
export type { Policy };

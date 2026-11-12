import { execFileSync } from 'child_process';
import type { ChangedFile } from '../types';
import type { RepoReader } from '../manifests';

export class GitError extends Error {}

export function git(args: string[], opts: { cwd?: string; allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (opts.allowFail) return '';
    const err = e as { stderr?: string; message: string };
    throw new GitError((err.stderr || err.message).trim());
  }
}

export function repoRoot(cwd?: string): string {
  const out = git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true }).trim();
  if (!out) throw new GitError('Not inside a git repository. Run this from your clone of the project.');
  return out;
}

export function remotes(cwd: string): string[] {
  return git(['remote'], { cwd, allowFail: true }).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** The remote the PR will target: "upstream" for forks, otherwise "origin". */
export function targetRemote(cwd: string, preferred?: string): string {
  const list = remotes(cwd);
  if (preferred) {
    if (!list.includes(preferred)) throw new GitError(`Remote "${preferred}" not found. Remotes: ${list.join(', ') || 'none'}.`);
    return preferred;
  }
  if (list.includes('upstream')) return 'upstream';
  if (list.includes('origin')) return 'origin';
  throw new GitError('No git remote found. Add the project you are contributing to as "upstream" or "origin".');
}

export function remoteRepo(cwd: string, remote: string): { owner: string; repo: string } | undefined {
  const url = git(['remote', 'get-url', remote], { cwd, allowFail: true }).trim();
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

function refExists(cwd: string, ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true }).trim() !== '';
}

export function baseBranch(cwd: string, remote: string, preferred?: string): string {
  if (preferred) return preferred;
  const head = git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd, allowFail: true }).trim();
  if (head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  for (const b of ['main', 'master', 'develop', 'trunk']) if (refExists(cwd, `${remote}/${b}`)) return b;
  throw new GitError(`Could not find the base branch on "${remote}". Pass it with --base <branch>.`);
}

export function fetchBase(cwd: string, remote: string, base: string): boolean {
  try {
    git(['fetch', '--quiet', remote, base], { cwd });
    return true;
  } catch {
    return false; // offline is fine if we already have the ref
  }
}

export function mergeBase(cwd: string, baseRef: string): string {
  if (!refExists(cwd, baseRef)) throw new GitError(`Base "${baseRef}" not found. Run: git fetch ${baseRef.replace('/', ' ')}`);
  const mb = git(['merge-base', 'HEAD', baseRef], { cwd, allowFail: true }).trim();
  if (!mb) throw new GitError(`Your branch has no common history with ${baseRef}.`);
  return mb;
}

export function currentBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim();
}

export function lastCommitSubject(cwd: string): string {
  return git(['log', '-1', '--format=%s'], { cwd, allowFail: true }).trim();
}

export function hasUncommittedChanges(cwd: string): boolean {
  return git(['status', '--porcelain', '--untracked-files=no'], { cwd, allowFail: true }).trim() !== '';
}

const STATUS: Record<string, ChangedFile['status']> = {
  M: 'modified', A: 'added', D: 'removed', R: 'renamed', C: 'added', T: 'changed',
};

/** Files changed between the merge base and HEAD, shaped like GitHub's PR files API. */
export function changedFiles(cwd: string, mb: string): ChangedFile[] {
  const lines = git(['diff', '--name-status', '-M', mb, 'HEAD'], { cwd }).split('\n').filter(Boolean);
  const files: ChangedFile[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const code = parts[0][0];
    const paths = parts.slice(1);
    const filename = paths[paths.length - 1];
    const status = STATUS[code] ?? 'modified';
    const patch = git(['diff', '-M', mb, 'HEAD', '--', ...paths], { cwd });
    let additions = 0;
    let deletions = 0;
    const hunks: string[] = [];
    let inHunk = false;
    for (const l of patch.split('\n')) {
      if (l.startsWith('@@')) inHunk = true;
      if (!inHunk) continue; // skip "diff --git", "index", "---", "+++" headers
      hunks.push(l);
      if (l.startsWith('+')) additions++;
      else if (l.startsWith('-')) deletions++;
    }
    const sha = status === 'removed' ? undefined : git(['rev-parse', `HEAD:${filename}`], { cwd }).trim();
    files.push({ filename, status, additions, deletions, patch: hunks.join('\n') || undefined, sha });
  }
  return files;
}

/** RepoReader over a commit in the local repository. */
export function localReader(cwd: string, rev = 'HEAD'): RepoReader {
  return {
    async read(path) {
      return readAt(cwd, rev, path);
    },
    async list(dir) {
      const out = git(['ls-tree', dir ? `${rev}:${dir}` : rev], { cwd, allowFail: true });
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [meta, name] = l.split('\t');
          return { path: name, type: meta.split(' ')[1] };
        });
    },
  };
}

function exists(cwd: string, rev: string, path: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${rev}:${path}`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Read a file at a ref (e.g. "upstream/main"), or undefined if missing. */
export function readAt(cwd: string, ref: string, path: string): string | undefined {
  return exists(cwd, ref, path) ? git(['cat-file', '-p', `${ref}:${path}`], { cwd }) : undefined;
}

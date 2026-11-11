import type { ChangedFile } from './types';

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock',
  'go.sum', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'flake.lock', 'packages.lock.json',
]);

const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)vendor\//, /(^|\/)node_modules\//,
  /\.min\.(js|css)$/, /\.map$/, /\.snap$/, /(^|\/)__snapshots__\//, /\.pb\.go$/, /_pb2\.py$/, /\.generated\./,
];

const CODE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'rb', 'php', 'cs', 'fs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'm', 'mm', 'swift', 'dart', 'ex', 'exs',
  'erl', 'clj', 'lua', 'r', 'jl', 'zig', 'nim', 'vue', 'svelte', 'sol', 'gd', 'hs', 'ml', 'elm',
]);

const DOC_EXT = new Set(['md', 'mdx', 'rst', 'txt', 'adoc']);

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function ext(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

export function isLockfile(p: string): boolean {
  return LOCKFILES.has(basename(p));
}

export function isGenerated(p: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(p));
}

export function isIgnored(p: string, ignorePaths: string[]): boolean {
  return isLockfile(p) || isGenerated(p) || ignorePaths.some((prefix) => p.startsWith(prefix));
}

export function isTestFile(p: string): boolean {
  const lower = p.toLowerCase();
  const b = basename(lower);
  return (
    /(^|\/)(tests?|__tests__|spec|specs|testing|e2e)\//.test(lower) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(b) ||
    /_test\.(go|py|rb|exs?|dart)$/.test(b) ||
    /^test_.*\.py$/.test(b) ||
    /(Test|Tests|Spec)\.(java|kt|cs|swift|scala|php)$/.test(basename(p))
  );
}

export function isCodeFile(p: string): boolean {
  return CODE_EXT.has(ext(p)) && !isTestFile(p);
}

export function isDocFile(p: string): boolean {
  return DOC_EXT.has(ext(p));
}

export function isWorkflowFile(p: string): boolean {
  return p.startsWith('.github/workflows/') || p.startsWith('.github/actions/');
}

/** Lines added by the PR (without the leading "+"), excluding diff headers. */
export function addedLines(file: ChangedFile): string[] {
  if (!file.patch) return [];
  const out: string[] = [];
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out;
}

const LINE_COMMENT: Record<string, RegExp> = {
  slash: /^\s*(\/\/|\/\*|\*(?!\*\/)|\*\/)/,
  hash: /^\s*#(?!!)/,
  dash: /^\s*--/,
};

export function commentStyle(p: string): RegExp | undefined {
  const e = ext(p);
  if (['py', 'rb', 'r', 'ex', 'exs', 'jl', 'nim', 'gd', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml'].includes(e)) return LINE_COMMENT.hash;
  if (['lua', 'hs', 'sql', 'elm'].includes(e)) return LINE_COMMENT.dash;
  if (CODE_EXT.has(e)) return LINE_COMMENT.slash;
  return undefined;
}

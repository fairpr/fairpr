// Core data types. The engine is pure: it receives a PrContext and returns a
// Report, so the same logic powers the GitHub Action, the CLI and benchmarks.

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  /** Unified diff for this file. May be missing for binary or very large files. */
  patch?: string;
  /** Git blob SHA of the file at the PR head (empty for removed files). */
  sha?: string;
}

export interface Author {
  login: string;
  /** Days since the GitHub account was created. */
  accountAgeDays?: number;
  isBot: boolean;
  /** True if the author has never had a PR merged in this repo. */
  isFirstTimeContributor: boolean;
  /** True if the author is an owner/member/collaborator of the repo. */
  isMaintainer: boolean;
  /** PRs opened by this author across all of GitHub in the last 24 hours. */
  prsOpenedLast24h?: number;
}

export interface Manifests {
  /** Dependency names declared in package.json (all dependency sections). */
  npm?: Set<string>;
  /** Dependency names declared in requirements*.txt / pyproject.toml (normalised, lowercase). */
  python?: Set<string>;
  /** Local top-level Python module names in the repo (so `import mypkg` is not flagged). */
  pythonLocalModules?: Set<string>;
  /** Path aliases from tsconfig (e.g. "@/", "~/") that are not packages. */
  jsAliases?: string[];
  /**
   * True when we could not see every relevant manifest (monorepo workspaces,
   * setup.py-only projects...). Unknown imports are then reported as hints,
   * never as signals, to avoid false accusations.
   */
  npmIncomplete?: boolean;
  pythonIncomplete?: boolean;
}

export interface PrContext {
  number?: number;
  title: string;
  body: string;
  author: Author;
  files: ChangedFile[];
  manifests: Manifests;
}

export type Verdict = 'verified' | 'needs-info' | 'quarantine';

/**
 * policy  = the PR breaks a rule the maintainer configured (fixable by the contributor)
 * signal  = a pattern strongly associated with low-effort AI-generated PRs
 * hint    = weak signal, shown but never changes the verdict on its own
 */
export type FindingKind = 'policy' | 'signal' | 'hint';

export interface Finding {
  id: string;
  kind: FindingKind;
  title: string;
  /** What we found, in plain words. */
  detail: string;
  /** How the contributor can fix it. */
  fix: string;
}

export interface Report {
  verdict: Verdict;
  findings: Finding[];
  /** Checks that ran and passed (ids), for transparency. */
  passed: string[];
  skipped: { id: string; reason: string }[];
  proof?: ProofResult;
}

export interface ProofResult {
  present: boolean;
  valid: boolean;
  reason?: string;
}

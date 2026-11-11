import { parse } from 'yaml';

export type AiPolicy = 'allowed' | 'allowed_with_disclosure' | 'not_allowed';
export type Mode = 'label' | 'comment' | 'dry-run';

export interface Policy {
  /** How the repo treats AI-assisted contributions. */
  ai_policy: AiPolicy;
  /** Require "Fixes #123" or a link to an issue in the PR description. */
  require_linked_issue: boolean;
  /** Max added+deleted lines, ignoring lockfiles and generated files. 0 = no limit. */
  max_changed_lines: number;
  /** Max number of changed files. 0 = no limit. */
  max_changed_files: number;
  /** If source code changes, at least one test file must change too. */
  require_tests_for_code_changes: boolean;
  /** Minimum length of a real (non-template) PR description. */
  min_description_length: number;
  /** Accounts younger than this are treated with extra care. */
  new_account_days: number;
  /** PRs opened across GitHub in 24h above which we flag "spray" behaviour. */
  spray_threshold: number;
  /** label: comment + labels. comment: comment only. dry-run: log only. */
  mode: Mode;
  /** Never check PRs from these users. Bots are always skipped. */
  allowlist: string[];
  /** Skip checks for owners/members/collaborators. */
  skip_maintainers: boolean;
  /** Skip checks for authors who already had a PR merged here. */
  skip_returning_contributors: boolean;
  /** Extra glob-like path prefixes ignored for size/test checks (e.g. "docs/"). */
  ignore_paths: string[];
  /** Label names. */
  labels: { verified: string; needs_info: string; quarantine: string };
}

export const DEFAULT_POLICY: Policy = {
  ai_policy: 'allowed_with_disclosure',
  require_linked_issue: false,
  max_changed_lines: 800,
  max_changed_files: 30,
  require_tests_for_code_changes: false,
  min_description_length: 40,
  new_account_days: 14,
  spray_threshold: 10,
  mode: 'label',
  allowlist: [],
  skip_maintainers: true,
  skip_returning_contributors: true,
  ignore_paths: [],
  labels: {
    verified: 'proofpr: verified',
    needs_info: 'proofpr: needs info',
    quarantine: 'proofpr: quarantine',
  },
};

export class PolicyError extends Error {}

const AI_POLICIES: AiPolicy[] = ['allowed', 'allowed_with_disclosure', 'not_allowed'];
const MODES: Mode[] = ['label', 'comment', 'dry-run'];

/**
 * Parse .github/proofpr.yml. Unknown keys are reported (typos are a common
 * source of "why is my rule ignored?"), invalid values throw a clear error.
 */
export function parsePolicy(yamlText: string | undefined): { policy: Policy; warnings: string[] } {
  const warnings: string[] = [];
  const policy: Policy = structuredClone(DEFAULT_POLICY);
  if (!yamlText || !yamlText.trim()) return { policy, warnings };

  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new PolicyError(`.github/proofpr.yml is not valid YAML: ${(e as Error).message}`);
  }
  if (raw === null || raw === undefined) return { policy, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError('.github/proofpr.yml must be a mapping of settings (key: value).');
  }

  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!(key in DEFAULT_POLICY)) warnings.push(`Unknown setting "${key}" in .github/proofpr.yml was ignored.`);
  }

  const bool = (k: keyof Policy) => {
    if (r[k] === undefined) return;
    if (typeof r[k] !== 'boolean') throw new PolicyError(`"${k}" must be true or false.`);
    (policy as any)[k] = r[k];
  };
  const num = (k: keyof Policy) => {
    if (r[k] === undefined) return;
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PolicyError(`"${k}" must be a number >= 0.`);
    (policy as any)[k] = Math.floor(v);
  };
  const strList = (k: keyof Policy) => {
    if (r[k] === undefined) return;
    const v = r[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new PolicyError(`"${k}" must be a list of strings.`);
    (policy as any)[k] = v;
  };

  if (r.ai_policy !== undefined) {
    if (!AI_POLICIES.includes(r.ai_policy as AiPolicy)) {
      throw new PolicyError(`"ai_policy" must be one of: ${AI_POLICIES.join(', ')}.`);
    }
    policy.ai_policy = r.ai_policy as AiPolicy;
  }
  if (r.mode !== undefined) {
    if (!MODES.includes(r.mode as Mode)) throw new PolicyError(`"mode" must be one of: ${MODES.join(', ')}.`);
    policy.mode = r.mode as Mode;
  }
  (['require_linked_issue', 'require_tests_for_code_changes', 'skip_maintainers', 'skip_returning_contributors'] as const).forEach(bool);
  (['max_changed_lines', 'max_changed_files', 'min_description_length', 'new_account_days', 'spray_threshold'] as const).forEach(num);
  (['allowlist', 'ignore_paths'] as const).forEach(strList);

  if (r.labels !== undefined) {
    if (typeof r.labels !== 'object' || r.labels === null || Array.isArray(r.labels)) {
      throw new PolicyError('"labels" must be a mapping with verified / needs_info / quarantine.');
    }
    const l = r.labels as Record<string, unknown>;
    for (const k of ['verified', 'needs_info', 'quarantine'] as const) {
      if (l[k] !== undefined) {
        if (typeof l[k] !== 'string' || !(l[k] as string).trim()) throw new PolicyError(`"labels.${k}" must be a non-empty string.`);
        policy.labels[k] = (l[k] as string).trim();
      }
    }
  }

  return { policy, warnings };
}

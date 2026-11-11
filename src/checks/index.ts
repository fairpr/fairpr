import type { Finding, PrContext } from '../types';
import type { Policy } from '../policy';
import {
  addedLines, basename, commentStyle, ext, isCodeFile, isDocFile, isIgnored, isTestFile, isWorkflowFile,
} from '../files';
import { jsPackageName, jsSpecifiers, pyImportKnown, pyImports } from '../imports';

export type CheckResult = { findings: Finding[] } | { skip: string };

export interface Check {
  id: string;
  run(ctx: PrContext, policy: Policy): CheckResult;
}

const ok = (): CheckResult => ({ findings: [] });
const skip = (reason: string): CheckResult => ({ skip: reason });
const found = (...findings: Finding[]): CheckResult => ({ findings });

/** PR body with HTML comments, template boilerplate and empty checkboxes removed. */
export function meaningfulBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l)) // headings
    .filter((l) => !/^\s*[-*]\s*\[[ xX]\]/.test(l)) // checklist items
    .filter((l) => !/^\s*(ai[\s-]*assist\w*|fixes|closes|resolves)\s*[:#]/i.test(l))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- disclosure

/** Parses "AI-Assisted: yes|no|partial" (also accepts "AI assistance:", "AI used:", bold markdown). */
export function parseDisclosure(body: string): 'yes' | 'no' | 'partial' | undefined {
  const m = body.match(/\bai[\s-]*(?:assisted|assistance|used|usage|generated)\s*\**\s*[:\-–]\s*\**\s*(yes|no|none|partial|partly|y|n)\b/i);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  if (v === 'y' || v === 'yes') return 'yes';
  if (v === 'n' || v === 'no' || v === 'none') return 'no';
  return 'partial';
}

const disclosure: Check = {
  id: 'ai-disclosure',
  run(ctx, policy) {
    if (policy.ai_policy === 'allowed') return skip('AI policy is "allowed"; no disclosure required.');
    const d = parseDisclosure(ctx.body);
    if (policy.ai_policy === 'allowed_with_disclosure') {
      if (d) return ok();
      return found({
        id: 'ai-disclosure', kind: 'policy',
        title: 'AI disclosure missing',
        detail: 'This repository accepts AI-assisted contributions but asks contributors to say whether AI was used.',
        fix: 'Add a line to the PR description: `AI-Assisted: yes`, `AI-Assisted: partial` or `AI-Assisted: no`.',
      });
    }
    // not_allowed
    if (d === 'yes' || d === 'partial') {
      return found({
        id: 'ai-disclosure', kind: 'policy',
        title: 'This repository does not accept AI-generated contributions',
        detail: `The PR declares \`AI-Assisted: ${d}\`, but the maintainers' policy is "not_allowed".`,
        fix: 'Please read CONTRIBUTING.md. If you wrote the change yourself, update the line to `AI-Assisted: no`.',
      });
    }
    if (!d) {
      return found({
        id: 'ai-disclosure', kind: 'policy',
        title: 'Please confirm this PR was written without AI',
        detail: 'This repository does not accept AI-generated contributions.',
        fix: 'Add the line `AI-Assisted: no` to the PR description to confirm.',
      });
    }
    return ok();
  },
};

// ---------------------------------------------------------------- linked issue

export function hasLinkedIssue(body: string): boolean {
  return /(^|[^\w&])#\d+\b/.test(body) || /github\.com\/[\w.-]+\/[\w.-]+\/(issues|discussions)\/\d+/.test(body) || /\bGH-\d+\b/.test(body);
}

const linkedIssue: Check = {
  id: 'linked-issue',
  run(ctx, policy) {
    if (!policy.require_linked_issue) return skip('Not required by policy.');
    if (hasLinkedIssue(ctx.body)) return ok();
    return found({
      id: 'linked-issue', kind: 'policy',
      title: 'No linked issue',
      detail: 'Maintainers here ask that every PR is connected to an issue, so the change is agreed on before work starts.',
      fix: 'Add `Fixes #<issue number>` to the description, or open an issue first to discuss the change.',
    });
  },
};

// ---------------------------------------------------------------- description

const description: Check = {
  id: 'description',
  run(ctx, policy) {
    const text = meaningfulBody(ctx.body);
    if (text.length >= policy.min_description_length) return ok();
    return found({
      id: 'description', kind: 'policy',
      title: text.length === 0 ? 'PR description is empty or only the template' : 'PR description is too short',
      detail: `The description has ${text.length} characters of real text (minimum ${policy.min_description_length}).`,
      fix: 'In your own words: what does this change, why is it needed, and how did you test it?',
    });
  },
};

// ---------------------------------------------------------------- size

const size: Check = {
  id: 'size',
  run(ctx, policy) {
    const counted = ctx.files.filter((f) => !isIgnored(f.filename, policy.ignore_paths));
    const lines = counted.reduce((s, f) => s + f.additions + f.deletions, 0);
    const findings: Finding[] = [];
    if (policy.max_changed_lines > 0 && lines > policy.max_changed_lines) {
      findings.push({
        id: 'size-lines', kind: 'policy',
        title: 'PR is too large to review',
        detail: `${lines} changed lines (limit ${policy.max_changed_lines}, lockfiles and generated files excluded).`,
        fix: 'Split this into smaller PRs that each do one thing.',
      });
    }
    if (policy.max_changed_files > 0 && counted.length > policy.max_changed_files) {
      findings.push({
        id: 'size-files', kind: 'policy',
        title: 'PR touches too many files',
        detail: `${counted.length} files changed (limit ${policy.max_changed_files}).`,
        fix: 'Keep each PR focused on one change; move unrelated edits to separate PRs.',
      });
    }
    return { findings };
  },
};

// ---------------------------------------------------------------- tests

const tests: Check = {
  id: 'tests',
  run(ctx, policy) {
    const files = ctx.files.filter((f) => f.status !== 'removed' && !isIgnored(f.filename, policy.ignore_paths));
    const code = files.filter((f) => isCodeFile(f.filename));
    if (code.length === 0) return skip('No source code changed.');
    if (files.some((f) => isTestFile(f.filename))) return ok();
    return found({
      id: 'tests',
      kind: policy.require_tests_for_code_changes ? 'policy' : 'hint',
      title: 'Code changed without tests',
      detail: `${code.length} source file(s) changed, but no test files were added or updated.`,
      fix: 'Add or update a test that fails without your change and passes with it.',
    });
  },
};

// ---------------------------------------------------------------- placeholder code

const PLACEHOLDER_RES: RegExp[] = [
  /\.\.\.\s*(existing|rest of( the)?|other|remaining|previous|same as before)\s*(code|implementation|logic|methods|content)/i,
  /\b(your|add your) (code|implementation|logic|api key) here\b/i,
  /\bTODO:?\s*(implement|add (the )?(actual|real)|replace with (actual|real))/i,
  /\b(in a real|for a real|in a production) (implementation|application|app|scenario|system|environment)\b/i,
  /\bplaceholder (implementation|logic|function|value)\b/i,
  /\b(this|the following) (is a )?(simplified|mock|dummy) (implementation|version|example)\b/i,
  /\breplace (this|it) with (your|the actual|a real)\b/i,
];

const placeholderCode: Check = {
  id: 'placeholder-code',
  run(ctx) {
    const hits: string[] = [];
    for (const f of ctx.files) {
      if (!isCodeFile(f.filename) && !isTestFile(f.filename)) continue;
      for (const line of addedLines(f)) {
        if (PLACEHOLDER_RES.some((re) => re.test(line))) {
          hits.push(`\`${f.filename}\`: \`${line.trim().slice(0, 100)}\``);
          if (hits.length >= 3) break;
        }
      }
      if (hits.length >= 3) break;
    }
    if (hits.length === 0) return ok();
    return found({
      id: 'placeholder-code', kind: 'signal',
      title: 'Placeholder or unfinished code',
      detail: `Added code contains placeholder text typical of unreviewed AI output:\n${hits.map((h) => `  - ${h}`).join('\n')}`,
      fix: 'Replace placeholders with the real implementation, or remove them.',
    });
  },
};

// ---------------------------------------------------------------- AI summary docs

const SUMMARY_DOC_RE = /^[A-Z0-9]+(?:[_-][A-Z0-9]+)*[_-](SUMMARY|REPORT|NOTES|PLAN|ANALYSIS|OVERVIEW|GUIDE|CHECKLIST|COMPLETE|DONE)\.md$/;
const SUMMARY_DOC_NAMES = new Set([
  'IMPLEMENTATION.md', 'CHANGES_MADE.md', 'FIXES.md', 'SOLUTION.md', 'PR_DESCRIPTION.md', 'NEXT_STEPS.md', 'TESTING_INSTRUCTIONS.md',
]);

const summaryDocs: Check = {
  id: 'summary-docs',
  run(ctx) {
    const added = ctx.files.filter((f) => f.status === 'added' && isDocFile(f.filename));
    const hits = added.filter((f) => SUMMARY_DOC_RE.test(basename(f.filename)) || SUMMARY_DOC_NAMES.has(basename(f.filename)));
    if (hits.length === 0) return ok();
    return found({
      id: 'summary-docs', kind: 'signal',
      title: 'Agent "summary" files added',
      detail: `New files like ${hits.slice(0, 3).map((f) => `\`${f.filename}\``).join(', ')} are usually notes an AI agent writes about its own work, not project documentation.`,
      fix: 'Remove these files; put the useful parts in the PR description instead.',
    });
  },
};

// ---------------------------------------------------------------- hallucinated imports

const hallucinatedImports: Check = {
  id: 'unknown-imports',
  run(ctx) {
    const npm = ctx.manifests.npm;
    const py = ctx.manifests.python;
    const unknown: { file: string; name: string; incomplete: boolean }[] = [];
    let looked = false;

    for (const f of ctx.files) {
      if (f.status === 'removed') continue;
      const e = ext(f.filename);
      const isJs = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'].includes(e);
      const isPy = e === 'py';
      if (isJs && npm) {
        looked = true;
        for (const line of addedLines(f)) {
          for (const spec of jsSpecifiers(line)) {
            const name = jsPackageName(spec, ctx.manifests.jsAliases);
            if (name && !npm.has(name) && !npm.has(`@types/${name}`)) {
              unknown.push({ file: f.filename, name, incomplete: !!ctx.manifests.npmIncomplete });
            }
          }
        }
      }
      if (isPy && py) {
        looked = true;
        for (const line of addedLines(f)) {
          for (const top of pyImports(line)) {
            if (!pyImportKnown(top, py, ctx.manifests.pythonLocalModules ?? new Set())) {
              unknown.push({ file: f.filename, name: top, incomplete: !!ctx.manifests.pythonIncomplete });
            }
          }
        }
      }
    }
    if (!looked) return skip('No JS/TS or Python changes with a readable dependency manifest.');
    if (unknown.length === 0) return ok();

    const uniq = [...new Map(unknown.map((u) => [u.name, u])).values()];
    const certain = uniq.filter((u) => !u.incomplete);
    const list = uniq.slice(0, 5).map((u) => `\`${u.name}\` (in \`${u.file}\`)`).join(', ');
    return found({
      id: 'unknown-imports',
      kind: certain.length > 0 ? 'signal' : 'hint',
      title: 'Imports of packages the project does not depend on',
      detail: `${list}${uniq.length > 5 ? ` and ${uniq.length - 5} more` : ''}. Code that imports packages which are not installed will not run, and is a common sign of AI-invented APIs.`,
      fix: 'Remove the import, use what the project already depends on, or add the dependency to the manifest and explain why it is needed.',
    });
  },
};

// ---------------------------------------------------------------- workflow changes

const workflowChanges: Check = {
  id: 'workflow-changes',
  run(ctx) {
    if (!ctx.author.isFirstTimeContributor) return skip('Author is a returning contributor.');
    const wf = ctx.files.filter((f) => isWorkflowFile(f.filename));
    if (wf.length === 0) return ok();
    return found({
      id: 'workflow-changes', kind: 'signal',
      title: 'First contribution changes CI workflows',
      detail: `This PR edits ${wf.map((f) => `\`${f.filename}\``).join(', ')}. Workflow changes from new contributors need careful security review.`,
      fix: 'Move workflow changes into a separate PR and explain why they are needed, or open an issue first.',
    });
  },
};

// ---------------------------------------------------------------- contributor activity

const spray: Check = {
  id: 'spray',
  run(ctx, policy) {
    const n = ctx.author.prsOpenedLast24h;
    if (n === undefined) return skip('Activity data unavailable.');
    if (n < policy.spray_threshold) return ok();
    return found({
      id: 'spray', kind: 'signal',
      title: 'Very high PR volume from this account',
      detail: `@${ctx.author.login} opened ${n} pull requests across GitHub in the last 24 hours (threshold ${policy.spray_threshold}).`,
      fix: 'Focus on fewer contributions and make sure each one is tested and understood.',
    });
  },
};

const newAccount: Check = {
  id: 'new-account',
  run(ctx, policy) {
    const age = ctx.author.accountAgeDays;
    if (age === undefined) return skip('Account age unavailable.');
    if (age >= policy.new_account_days) return ok();
    return found({
      id: 'new-account', kind: 'hint',
      title: 'New GitHub account',
      detail: `The account is ${age} day(s) old. This alone is fine. Welcome! It is shown only as context for reviewers.`,
      fix: 'Nothing to fix. A clear description and tests help reviewers trust new contributors.',
    });
  },
};

// ---------------------------------------------------------------- chat-paste and text tells

const CHAT_PASTE_RES: RegExp[] = [
  /\bas an ai (language )?model\b/i,
  /\bi hope this helps\b/i,
  /^\s*(certainly|sure|absolutely|great question)[!,.]/im,
  /\bhere(?:'s| is) (?:the|an?) (?:updated|revised|complete|improved) (?:code|version|implementation)\b/i,
  /\blet me know if you (?:need|have|want)\b/i,
  /\bi(?:'ve| have) (?:made|implemented) the following changes\b/i,
];

const TELL_WORDS = [
  'seamlessly', 'comprehensive', 'robust', 'leverage', 'leverages', 'streamline', 'streamlines', 'enhance', 'enhances',
  'enhanced', 'delve', 'meticulous', 'utilize', 'utilizes', 'facilitate', 'paradigm', 'holistic', 'cutting-edge',
  'state-of-the-art', 'elevate', 'bolster', 'pivotal', 'furthermore', 'additionally',
];

const textTells: Check = {
  id: 'text-tells',
  run(ctx) {
    const text = `${ctx.title}\n${ctx.body}`;
    const paste = CHAT_PASTE_RES.filter((re) => re.test(text));
    const findings: Finding[] = [];
    if (paste.length > 0) {
      findings.push({
        id: 'chat-paste', kind: 'signal',
        title: 'Description looks pasted from an AI chat',
        detail: 'The PR text contains phrases from a chatbot conversation (for example "I hope this helps" or "Here is the updated code").',
        fix: 'Rewrite the description yourself: what changed, why, and how you tested it.',
      });
    }
    const lower = text.toLowerCase();
    const words = TELL_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
    const emojiHeadings = (ctx.body.match(/^#{1,6}\s*\p{Extended_Pictographic}/gmu) ?? []).length;
    if (words.length >= 4 || emojiHeadings >= 3) {
      findings.push({
        id: 'text-tells', kind: 'hint',
        title: 'Description has a generic AI writing style',
        detail: `Words like ${words.slice(0, 5).map((w) => `"${w}"`).join(', ')}${emojiHeadings >= 3 ? ` and ${emojiHeadings} emoji headings` : ''}. Not a problem by itself.`,
        fix: 'Plain, specific language helps reviewers: name the bug, the cause and the fix.',
      });
    }
    return { findings };
  },
};

// ---------------------------------------------------------------- comment density

const commentDensity: Check = {
  id: 'comment-density',
  run(ctx) {
    let comments = 0;
    let code = 0;
    for (const f of ctx.files) {
      if (!isCodeFile(f.filename)) continue;
      const style = commentStyle(f.filename);
      if (!style) continue;
      for (const line of addedLines(f)) {
        if (!line.trim()) continue;
        if (style.test(line)) comments++;
        else code++;
      }
    }
    if (comments + code < 40) return skip('Too few added lines to judge.');
    const ratio = comments / Math.max(code, 1);
    if (ratio < 0.6) return ok();
    return found({
      id: 'comment-density', kind: 'hint',
      title: 'Unusually many comments',
      detail: `${comments} comment lines for ${code} lines of code. Over-explaining obvious code is common in generated output.`,
      fix: 'Keep comments that explain *why*; remove ones that restate what the code does.',
    });
  },
};

export const CHECKS: Check[] = [
  disclosure, linkedIssue, description, size, tests,
  placeholderCode, summaryDocs, hallucinatedImports, workflowChanges, spray, textTells,
  newAccount, commentDensity,
];

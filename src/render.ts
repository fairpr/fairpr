import type { Finding, Report } from './types';
import type { Policy } from './policy';

export const COMMENT_MARKER = '<!-- proofpr:report -->';

const HEADLINES: Record<Report['verdict'], string> = {
  verified: '✅ **ProofPR: ready for review**',
  'needs-info': '📝 **ProofPR: a few things to fix before review**',
  quarantine: '⏸️ **ProofPR: on hold until a maintainer looks at it**',
};

const INTROS: Record<Report['verdict'], string> = {
  verified: 'This PR follows the repository\'s contribution policy. Thanks for the contribution!',
  'needs-info': 'Thanks for contributing! The maintainers ask for a few things before reviewing. Fix the items below and the check updates automatically.',
  quarantine:
    'Thanks for contributing! This PR matches several patterns that maintainers often see in low-effort automated PRs, so it has been set aside for a maintainer to look at. ' +
    'This is **not** a rejection, and real contributions are never closed automatically. Fixing the items below usually clears it.',
};

function renderFinding(f: Finding): string {
  return `- **${f.title}**: ${f.detail}\n  - 👉 ${f.fix}`;
}

export function renderComment(report: Report, policy: Policy, author: string): string {
  const lines: string[] = [COMMENT_MARKER, HEADLINES[report.verdict], '', `Hi @${author}! ${INTROS[report.verdict]}`, ''];

  const blocking = report.findings.filter((f) => f.kind !== 'hint');
  const hints = report.findings.filter((f) => f.kind === 'hint');

  if (report.proof?.present && report.proof.valid) {
    lines.push('🔏 The contributor ran the ProofPR self-check, and it matches the current code.', '');
  }

  if (blocking.length) {
    lines.push('#### To fix', ...blocking.map(renderFinding), '');
  }
  if (hints.length) {
    lines.push('<details><summary>Notes for reviewers (do not affect the result)</summary>', '', ...hints.map(renderFinding), '', '</details>', '');
  }

  lines.push(
    '<details><summary>How this works</summary>',
    '',
    `Checks passed: ${report.passed.length ? report.passed.map((p) => `\`${p}\``).join(', ') : 'none'}.`,
    report.skipped.length ? `Skipped: ${report.skipped.map((s) => `\`${s.id}\``).join(', ')}.` : '',
    '',
    `Repository policy: AI contributions are **${policy.ai_policy.replace(/_/g, ' ')}**.`,
    '',
    '- Updated your PR? Comment `/proofpr recheck`.',
    '- Maintainers can override with `/proofpr approve`.',
    '',
    '</details>',
    '',
    '<sub>[ProofPR](https://github.com/proofpr/proofpr): fair PR checks for the AI era</sub>',
  );

  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

export function renderSkipComment(reason: string): string {
  return `${COMMENT_MARKER}\n<sub>ProofPR skipped this PR: ${reason}</sub>`;
}

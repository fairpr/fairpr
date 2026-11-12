import * as fs from 'fs';
import * as path from 'path';
import type { Policy } from '../policy';
import type { FindingKind, Verdict } from '../types';

export type Group = 'merged' | 'closed-unmerged' | 'labeled-low-quality';

export interface BenchRecord {
  repo: string;
  number: number;
  url: string;
  title: string;
  group: Group;
  labels: string[];
  createdAt: string;
  verdict: Verdict;
  findings: { id: string; kind: FindingKind; title: string }[];
  changedFiles: number;
}

const GROUPS: { id: Group; name: string; meaning: string }[] = [
  { id: 'labeled-low-quality', name: 'Labeled spam / invalid / AI slop', meaning: 'maintainers explicitly labeled it low quality' },
  { id: 'closed-unmerged', name: 'Closed without merging', meaning: 'rejected or abandoned, for any reason' },
  { id: 'merged', name: 'Merged', meaning: 'maintainers accepted it' },
];

/** Wilson 95% interval, in percent. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, ((c - m) / d) * 100), Math.min(100, ((c + m) / d) * 100)];
}

const pct = (k: number, n: number) => (n ? `${((k / n) * 100).toFixed(1)}%` : 'n/a');
const ci = (k: number, n: number) => {
  if (!n) return '';
  const [lo, hi] = wilson(k, n);
  return ` (95% CI ${lo.toFixed(1)}–${hi.toFixed(1)}%)`;
};
const hasSignal = (r: BenchRecord) => r.findings.some((f) => f.kind === 'signal');

export function buildReport(records: BenchRecord[], meta: { repos: string[]; since: string; policy: Policy }): string {
  const by = (g: Group) => records.filter((r) => r.group === g);
  const lines: string[] = [];
  const repos = [...new Set(records.map((r) => r.repo))];

  lines.push('# FairPR benchmark on real pull requests', '');
  lines.push(
    `Measured **${records.length}** closed pull requests from **first-time contributors** in ${repos.length} public repositories, created since ${meta.since}.`,
    '',
    'Each PR was checked with FairPR exactly as the GitHub Action would check it, then compared with what the maintainers actually did.',
    '',
  );

  // ---- headline
  const merged = by('merged');
  const closed = by('closed-unmerged');
  const labeled = by('labeled-low-quality');
  const q = (rs: BenchRecord[]) => rs.filter((r) => r.verdict === 'quarantine').length;
  const s = (rs: BenchRecord[]) => rs.filter(hasSignal).length;

  lines.push('## Headline numbers', '');
  if (labeled.length) {
    lines.push(`- **${pct(q(labeled), labeled.length)}** of PRs that maintainers labeled spam/invalid/AI slop were put on hold${ci(q(labeled), labeled.length)}, n=${labeled.length}.`);
  }
  lines.push(`- **${pct(q(closed), closed.length)}** of PRs closed without merging were put on hold${ci(q(closed), closed.length)}, n=${closed.length}.`);
  lines.push(`- **${pct(q(merged), merged.length)}** of PRs that were **merged** were put on hold${ci(q(merged), merged.length)}, n=${merged.length}. This is the false-alarm rate on good PRs (an upper bound: a few merged PRs were still low quality).`);
  if (merged.length && closed.length && q(merged) > 0) {
    const ratio = (q(closed) / closed.length) / (q(merged) / merged.length);
    lines.push(`- A closed-unmerged PR was **${ratio.toFixed(1)}×** as likely to be put on hold as a merged one.`);
  }
  lines.push('');

  // ---- verdict table
  lines.push('## Verdicts by outcome', '', '| What maintainers did | PRs | Verified | Needs info | On hold | Any slop signal |', '|---|---:|---:|---:|---:|---:|');
  for (const g of GROUPS) {
    const rs = by(g.id);
    if (!rs.length) continue;
    const v = (x: Verdict) => pct(rs.filter((r) => r.verdict === x).length, rs.length);
    lines.push(`| ${g.name} | ${rs.length} | ${v('verified')} | ${v('needs-info')} | ${v('quarantine')} | ${pct(s(rs), rs.length)} |`);
  }
  lines.push('', '"Needs info" is mostly policy items (short description, very large PR). "On hold" requires slop signals. The AI-disclosure rule was switched off because these projects do not require it.', '');

  // ---- per check
  const ids = [...new Set(records.flatMap((r) => r.findings.map((f) => f.id)))].sort();
  if (ids.length) {
    lines.push('## How often each check fired', '', `| Check | ${GROUPS.filter((g) => by(g.id).length).map((g) => g.name).join(' | ')} |`, `|---|${GROUPS.filter((g) => by(g.id).length).map(() => '---:').join('|')}|`);
    for (const id of ids) {
      const cells = GROUPS.filter((g) => by(g.id).length).map((g) => {
        const rs = by(g.id);
        return pct(rs.filter((r) => r.findings.some((f) => f.id === id)).length, rs.length);
      });
      lines.push(`| \`${id}\` | ${cells.join(' | ')} |`);
    }
    lines.push('', 'A useful check fires much more often on rejected PRs than on merged ones.', '');
  }

  // ---- per repo
  lines.push('## By repository', '', '| Repository | PRs | Merged on hold | Closed on hold |', '|---|---:|---:|---:|');
  for (const repo of repos) {
    const rs = records.filter((r) => r.repo === repo);
    const m = rs.filter((r) => r.group === 'merged');
    const c = rs.filter((r) => r.group !== 'merged');
    lines.push(`| ${repo} | ${rs.length} | ${pct(q(m), m.length)} (${q(m)}/${m.length}) | ${pct(q(c), c.length)} (${q(c)}/${c.length}) |`);
  }
  lines.push('');

  // ---- review lists
  const list = (title: string, rs: BenchRecord[], limit = 40) => {
    if (!rs.length) return;
    lines.push(`## ${title}`, '');
    for (const r of rs.slice(0, limit)) {
      const why = r.findings.filter((f) => f.kind !== 'hint').map((f) => f.id).join(', ') || 'no findings';
      lines.push(`- [${r.repo}#${r.number}](${r.url}): ${r.title.replace(/[[\]|]/g, ' ')} *(${why})*`);
    }
    if (rs.length > limit) lines.push(`- …and ${rs.length - limit} more in results.jsonl`);
    lines.push('');
  };
  list('Merged PRs that were put on hold: review these (possible false alarms)', merged.filter((r) => r.verdict === 'quarantine'));
  list('Labeled low-quality PRs that FairPR verified (missed)', labeled.filter((r) => r.verdict === 'verified'));
  list('Examples: closed PRs put on hold', closed.filter((r) => r.verdict === 'quarantine'), 15);

  // ---- method
  lines.push(
    '## Method and limits',
    '',
    `- Repositories: ${meta.repos.join(', ')}.`,
    '- Sample: the most recent closed PRs per repository whose author had no previous merged contribution there (GitHub "first-time contributor" or "none"), excluding bots and drafts.',
    '- "Closed without merging" includes many reasonable PRs (duplicates, stale, superseded), so its on-hold rate is not a precision score. The merged group is the fair measure of false alarms.',
    '- GitHub reports the author\'s *current* relationship to the repo, so a few early contributors who later got PRs merged are missing from the sample.',
    '- The "spray" check (many PRs across GitHub in 24 hours) cannot be reconstructed for past PRs and was not measured.',
    `- Policy used: ai_policy=allowed, max_changed_lines=${meta.policy.max_changed_lines}, max_changed_files=${meta.policy.max_changed_files}, min_description_length=${meta.policy.min_description_length}.`,
    '- Raw per-PR results are in `results.jsonl` so anyone can re-check them.',
    '',
  );
  return lines.join('\n');
}

export function writeReport(records: BenchRecord[], outDir: string, meta: { repos: string[]; since: string; policy: Policy }): string {
  const p = path.join(outDir, 'REPORT.md');
  fs.writeFileSync(p, buildReport(records, meta));
  return p;
}

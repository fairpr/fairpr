// End-to-end test of `npx proofpr check` on real git repositories.
// Also proves the CLI's proof matches what the Action computes from GitHub's
// blob SHAs (computed here independently with `git hash-object`).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const require = createRequire(import.meta.url);
execFileSync('npx', ['tsc', '--outDir', path.join(root, '.e2e-lib')], { cwd: root, stdio: 'inherit' });
const { verifyProof } = require(path.join(root, '.e2e-lib/proof.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpr-cli-'));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, file, content) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content); };
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', NO_COLOR: '1' };
process.env = env;

// --- upstream project with a policy and a test command
const upstream = path.join(tmp, 'upstream');
fs.mkdirSync(upstream);
sh(upstream, 'init', '-q', '-b', 'main');
write(upstream, 'package.json', JSON.stringify({ name: 'demo', dependencies: { axios: '^1.0.0' } }));
write(upstream, 'src/client.ts', "import axios from 'axios';\nexport const get = axios.get;\n");
write(upstream, '.github/proofpr.yml', 'ai_policy: allowed_with_disclosure\ntest_command: node -e "process.exit(0)"\n');
sh(upstream, 'add', '-A');
sh(upstream, 'commit', '-qm', 'init');

// --- contributor clone on a feature branch
const clone = path.join(tmp, 'clone');
sh(tmp, 'clone', '-q', upstream, clone);
sh(clone, 'checkout', '-qb', 'feature');

const cli = (args, cwd = clone) => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin/proofpr.js'), ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
};
const answers = ['--yes', '--problem', 'GET requests are slow because nothing is cached.', '--change', 'Added a small in-memory cache with a 30 second expiry.', '--tested', 'Ran the test suite and called the endpoint twice locally.', '--ai', 'partial'];

try {
  // 1) Sloppy change: unknown package + placeholder + agent summary file -> blocked, exit 1, no proof
  write(clone, 'src/cache.ts', "import { lru } from 'imaginary-cache';\n// ... existing code ...\nexport const c = lru;\n");
  write(clone, 'CACHE_SUMMARY.md', '# What I did\n');
  sh(clone, 'add', '-A');
  sh(clone, 'commit', '-qm', 'Add cache');
  let r = cli(['check', ...answers]);
  assert.equal(r.code, 1, r.out);
  for (const s of ['imaginary-cache', 'Placeholder', 'CACHE_SUMMARY.md']) assert.ok(r.out.includes(s), `should mention ${s}\n${r.out}`);
  assert.ok(!fs.existsSync(path.join(clone, '.git/proofpr/PR_BODY.md')), 'no proof for a failing PR');
  console.log('✓ sloppy change is blocked with clear fixes and no proof');

  // 2) Fix it -> passes, tests run, description + proof written
  write(clone, 'src/cache.ts', "import axios from 'axios';\nconst store = new Map();\nexport async function cachedGet(url) {\n  if (!store.has(url)) store.set(url, await axios.get(url));\n  return store.get(url);\n}\n");
  write(clone, 'src/cache.test.ts', "it('caches', () => {});\n");
  fs.rmSync(path.join(clone, 'CACHE_SUMMARY.md'));
  sh(clone, 'add', '-A');
  sh(clone, 'commit', '-qm', 'Add response cache for GET requests');
  r = cli(['check', ...answers]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Tests passed/);
  const body = fs.readFileSync(path.join(clone, '.git/proofpr/PR_BODY.md'), 'utf8');
  assert.match(body, /AI-Assisted: partial/);
  assert.match(body, /Ran `node -e "process.exit\(0\)"`: passed/);
  assert.match(body, /proofpr:proof v1 fingerprint: sha256:[a-f0-9]{64}/);
  console.log('✓ clean change passes, runs tests and writes a description with proof');

  // 3) The proof matches what the Action computes from GitHub blob SHAs
  const mb = sh(clone, 'merge-base', 'HEAD', 'origin/main').trim();
  const changed = sh(clone, 'diff', '--name-status', '-M', mb, 'HEAD').trim().split('\n').map((l) => l.split('\t'));
  const githubFiles = changed.map(([code, ...paths]) => {
    const filename = paths.at(-1);
    const removed = code[0] === 'D';
    // GitHub's PR files API reports the blob SHA, which equals `git hash-object` of the file content.
    const sha = removed ? undefined : execFileSync('git', ['hash-object', path.join(clone, filename)], { encoding: 'utf8' }).trim();
    return { filename, status: removed ? 'removed' : code[0] === 'A' ? 'added' : 'modified', sha, additions: 0, deletions: 0 };
  });
  assert.deepEqual(verifyProof(body, githubFiles), { present: true, valid: true });
  console.log('✓ proof is valid against GitHub-style blob SHAs (CLI and Action agree)');

  // 4) Changing the code after the check invalidates the proof
  write(clone, 'src/cache.ts', fs.readFileSync(path.join(clone, 'src/cache.ts'), 'utf8') + '// sneaky change\n');
  const tampered = githubFiles.map((f) => (f.filename === 'src/cache.ts' ? { ...f, sha: execFileSync('git', ['hash-object', path.join(clone, 'src/cache.ts')], { encoding: 'utf8' }).trim() } : f));
  assert.equal(verifyProof(body, tampered).valid, false);
  console.log('✓ editing code after the check invalidates the proof');
  sh(clone, 'checkout', '--', 'src/cache.ts');

  // 5) Failing tests stop the PR
  sh(upstream, 'checkout', '-q', 'main');
  write(upstream, '.github/proofpr.yml', 'test_command: node -e "process.exit(3)"\n');
  sh(upstream, 'commit', '-qam', 'stricter');
  r = cli(['check', ...answers]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Tests failed/);
  console.log('✓ failing tests block the PR');

  // 6) Rules come from the target branch: a contributor editing the policy in their branch has no effect
  write(clone, '.github/proofpr.yml', 'test_command: ""\n');
  sh(clone, 'add', '-A');
  sh(clone, 'commit', '-qm', 'loosen rules');
  r = cli(['check', ...answers]);
  assert.match(r.out, /Tests failed/, 'policy must be read from upstream main, not the branch');
  console.log('✓ policy is read from the target branch, not the contributor branch');

  // 7) Project that bans AI: declaring AI use is blocked
  write(upstream, '.github/proofpr.yml', 'ai_policy: not_allowed\n');
  sh(upstream, 'commit', '-qam', 'no ai');
  r = cli(['check', ...answers]);
  assert.equal(r.code, 1);
  assert.match(r.out, /does not accept AI-generated contributions/);
  console.log('✓ projects that ban AI are respected');

  // 8) JSON mode for agents + missing answers in --yes mode
  r = cli(['check', '--yes', '--json']);
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.out).error, /Missing answer/);
  r = cli(['check', ...answers, '--json', '--ai', 'no']);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true, r.out);
  assert.match(j.fingerprint, /^sha256:/);
  console.log('✓ --json works for agents; --yes fails clearly when answers are missing');

  // 9) Helpful errors outside a repo / bad flags
  r = cli(['check'], tmp);
  assert.equal(r.code, 2);
  assert.match(r.out, /Not inside a git repository/);
  r = cli(['check', '--ai', 'maybe']);
  assert.equal(r.code, 2);
  console.log('✓ clear errors for wrong usage');

  console.log('\nAll CLI end-to-end checks passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(root, '.e2e-lib'), { recursive: true, force: true });
}

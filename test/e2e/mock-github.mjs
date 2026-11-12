// End-to-end test: runs the real bundled Action (dist/index.js) against a fake
// GitHub API server and checks the comment, labels and approval flow.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const b64 = (s) => Buffer.from(s).toString('base64');

function makeState() {
  return {
    comments: [],
    labels: new Set(),
    repoLabels: new Set(),
    reactions: [],
    nextId: 1,
    pr: {
      number: 7,
      title: 'Add caching to API client',
      body: 'This PR enhances the client. I hope this helps!\n\nAI-Assisted: yes',
      draft: false,
      author_association: 'FIRST_TIME_CONTRIBUTOR',
      user: { login: 'newbie', type: 'User' },
      head: { sha: 'headsha', ref: 'feature' },
      base: { ref: 'main' },
    },
    files: [
      { filename: 'src/client.ts', status: 'modified', additions: 3, deletions: 0, sha: 'f1',
        patch: "@@ -1 +1,3 @@\n+import { cache } from 'magic-cache-lib';\n+// ... existing code ...\n+export const c = cache;" },
      { filename: 'CACHE_IMPLEMENTATION_SUMMARY.md', status: 'added', additions: 1, deletions: 0, sha: 'f2', patch: '@@ -0,0 +1 @@\n+# Summary' },
    ],
    contents: {
      'package.json@headsha': JSON.stringify({ name: 'demo', dependencies: { axios: '^1' } }),
      '.github/fairpr.yml@main': 'ai_policy: allowed_with_disclosure\nmode: label\n',
    },
    permission: { maintainer: 'write', randomuser: 'read' },
  };
}

function serve(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data ?? {})); };
      const p = url.pathname;
      const m = (re) => p.match(re);
      let mm;
      if (req.method === 'GET' && p === '/repos/o/r/pulls/7') return send(200, state.pr);
      if (req.method === 'GET' && p === '/repos/o/r/pulls/7/files') return send(200, state.files);
      if (req.method === 'GET' && p === '/users/newbie') return send(200, { created_at: new Date(Date.now() - 3 * 864e5).toISOString() });
      if (req.method === 'GET' && p === '/search/issues') return send(200, { total_count: 2, items: [] });
      if (req.method === 'GET' && (mm = m(/^\/repos\/o\/r\/git\/trees\/(.+)$/))) return send(200, { tree: [{ path: 'package.json', type: 'blob' }, { path: 'src', type: 'tree' }] });
      if (req.method === 'GET' && (mm = m(/^\/repos\/o\/r\/contents\/(.+)$/))) {
        const key = `${decodeURIComponent(mm[1])}@${url.searchParams.get('ref')}`;
        const c = state.contents[key];
        return c === undefined ? send(404, { message: 'Not Found' }) : send(200, { type: 'file', encoding: 'base64', content: b64(c) });
      }
      if (req.method === 'GET' && p === '/repos/o/r/issues/7/comments') return send(200, state.comments);
      if (req.method === 'POST' && p === '/repos/o/r/issues/7/comments') { const c = { id: state.nextId++, body: json.body, user: { login: 'github-actions[bot]', type: 'Bot' } }; state.comments.push(c); return send(201, c); }
      if (req.method === 'PATCH' && (mm = m(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/))) { const c = state.comments.find((x) => x.id === +mm[1]); c.body = json.body; return send(200, c); }
      if (req.method === 'GET' && p === '/repos/o/r/issues/7/labels') return send(200, [...state.labels].map((name) => ({ name })));
      if (req.method === 'DELETE' && (mm = m(/^\/repos\/o\/r\/issues\/7\/labels\/(.+)$/))) { state.labels.delete(decodeURIComponent(mm[1])); return send(200, []); }
      if (req.method === 'POST' && p === '/repos/o/r/issues/7/labels') { json.labels.forEach((l) => state.labels.add(l)); return send(200, []); }
      if (req.method === 'GET' && (mm = m(/^\/repos\/o\/r\/labels\/(.+)$/))) return state.repoLabels.has(decodeURIComponent(mm[1])) ? send(200, {}) : send(404, {});
      if (req.method === 'POST' && p === '/repos/o/r/labels') { state.repoLabels.add(json.name); return send(201, {}); }
      if (req.method === 'GET' && (mm = m(/^\/repos\/o\/r\/collaborators\/([^/]+)\/permission$/))) return send(200, { permission: state.permission[mm[1]] ?? 'none' });
      if (req.method === 'POST' && (mm = m(/^\/repos\/o\/r\/issues\/comments\/(\d+)\/reactions$/))) { state.reactions.push(json.content); return send(201, {}); }
      console.error('UNHANDLED', req.method, p);
      send(500, { message: `unhandled ${req.method} ${p}` });
    });
  });
}

function runAction(port, eventName, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairpr-'));
  const eventPath = path.join(dir, 'event.json');
  const out = path.join(dir, 'out');
  const summary = path.join(dir, 'summary');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  fs.writeFileSync(out, '');
  fs.writeFileSync(summary, '');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: summary,
        'INPUT_GITHUB-TOKEN': 'fake',
        'INPUT_CONFIG-PATH': '.github/fairpr.yml',
        'INPUT_FAIL-ON-QUARANTINE': 'false',
        INPUT_MODE: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error('action timed out\n' + log)); }, 30000);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout: log, output: fs.readFileSync(out, 'utf8') }); });
  });
}

const state = makeState();
const server = serve(state).listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

try {
  // 1) Sloppy PR gets quarantined with one comment and one label
  let r = await runAction(port, 'pull_request_target', { pull_request: state.pr });
  assert.match(r.output, /quarantine/, r.stdout);
  assert.equal(state.comments.length, 1);
  assert.ok(state.labels.has('fairpr: quarantine'));
  const comment = state.comments[0].body;
  for (const s of ['placeholder', 'magic-cache-lib', 'CACHE_IMPLEMENTATION_SUMMARY.md', 'pasted from an AI chat', 'not** a rejection']) {
    assert.ok(comment.includes(s), `comment should mention ${s}\n${comment}`);
  }
  console.log('✓ sloppy PR quarantined with a clear comment');

  // 2) Contributor fixes everything and pushes: same comment updated, label switches
  state.pr.body = 'Adds an in-memory cache to the API client so repeated GET requests within 30s reuse the response. Tested with the existing test suite.\n\nAI-Assisted: partial';
  state.files = [
    { filename: 'src/client.ts', status: 'modified', additions: 2, deletions: 0, sha: 'f3', patch: "@@ -1 +1,2 @@\n+import axios from 'axios';\n+export const c = axios;" },
    { filename: 'src/client.test.ts', status: 'modified', additions: 1, deletions: 0, sha: 'f4', patch: '@@ -1 +1 @@\n+it("caches", () => {});' },
  ];
  r = await runAction(port, 'pull_request_target', { pull_request: state.pr });
  assert.match(r.output, /verified/, r.stdout);
  assert.equal(state.comments.length, 1, 'must update, not add, comments');
  assert.deepEqual([...state.labels], ['fairpr: verified']);
  console.log('✓ fixed PR becomes verified, comment updated in place, label swapped');

  // 3) Regression back to sloppy, then a non-maintainer tries /fairpr approve -> ignored
  state.pr.body = 'I hope this helps!';
  await runAction(port, 'pull_request_target', { pull_request: state.pr });
  r = await runAction(port, 'issue_comment', { issue: { number: 7, pull_request: {} }, comment: { id: 99, body: '/fairpr approve', user: { login: 'randomuser', type: 'User' } } });
  assert.ok(!state.labels.has('fairpr: verified'), 'non-maintainer must not approve');
  assert.equal(state.reactions.at(-1), 'confused');
  console.log('✓ non-maintainer cannot approve');

  // 4) Maintainer approves -> verified, and approval survives the next push
  await runAction(port, 'issue_comment', { issue: { number: 7, pull_request: {} }, comment: { id: 100, body: '/fairpr approve', user: { login: 'maintainer', type: 'User' } } });
  assert.ok(state.labels.has('fairpr: verified'));
  assert.match(state.comments[0].body, /Approved for review by @maintainer/);
  await runAction(port, 'pull_request_target', { pull_request: state.pr });
  assert.ok(state.labels.has('fairpr: verified'), 'approval should stick');
  console.log('✓ maintainer approval works and sticks across pushes');

  // 5) Maintainer-authored PRs are skipped entirely
  const before = state.comments[0].body;
  state.pr.author_association = 'MEMBER';
  r = await runAction(port, 'pull_request_target', { pull_request: state.pr });
  assert.match(r.output, /skipped/);
  assert.equal(state.comments[0].body, before);
  console.log('✓ maintainers are skipped');

  // 6) Broken config fails loudly with a helpful message
  state.pr.author_association = 'FIRST_TIME_CONTRIBUTOR';
  state.contents['.github/fairpr.yml@main'] = 'ai_policy: sometimes';
  r = await runAction(port, 'pull_request_target', { pull_request: state.pr });
  assert.match(r.stdout, /Configuration error: "ai_policy" must be one of/);
  console.log('✓ invalid config gives a clear error');

  console.log('\nAll end-to-end checks passed.');
} finally {
  server.close();
}

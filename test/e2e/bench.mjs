// End-to-end test of the benchmark against a simulated GitHub API.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const b64 = (s) => Buffer.from(s).toString('base64');
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();

const good = (n, merged = true) => ({
  number: n, title: `Fix bug ${n}`, body: 'Fixes a crash when the config file is empty. Added a regression test.',
  draft: false, author_association: 'FIRST_TIME_CONTRIBUTOR', user: { login: `dev${n}`, type: 'User' },
  merged_at: merged ? iso(1) : null, created_at: iso(2), labels: [], html_url: `https://github.com/o/r/pull/${n}`, head: { sha: `h${n}` },
});
const sloppy = (n, labels = []) => ({
  ...good(n, false), title: `Enhance robustness ${n}`, body: 'I hope this helps! Here is the updated code.',
  labels: labels.map((name) => ({ name })),
});

const pulls = [
  good(1), good(2), good(3), good(4),
  sloppy(5), sloppy(6, ['invalid']), sloppy(7, ['AI slop']),
  good(8, false),
  { ...good(9), author_association: 'MEMBER' },                       // maintainer: skipped
  { ...good(10), user: { login: 'renovate[bot]', type: 'Bot' } },       // bot: skipped
  { ...good(12), author_association: 'CONTRIBUTOR', user: { login: 'firstmerge', type: 'User' } },  // first merged PR: counted
  { ...good(13), author_association: 'CONTRIBUTOR', user: { login: 'regular', type: 'User' } },     // had earlier merges: skipped
  { ...good(11), created_at: iso(900) },                                // older than --since: stops
];
const files = (n) => {
  const p = pulls.find((x) => x.number === n);
  if (p.title.startsWith('Enhance')) {
    return [
      { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 0, sha: 's', patch: "@@\n+import x from 'not-a-real-pkg';\n+// ... existing code ..." },
      { filename: 'FIX_SUMMARY.md', status: 'added', additions: 1, deletions: 0, sha: 't', patch: '@@\n+# done' },
    ];
  }
  return [
    { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, sha: 's', patch: "@@\n+import axios from 'axios';" },
    { filename: 'src/a.test.ts', status: 'modified', additions: 1, deletions: 0, sha: 'u', patch: '@@\n+it("x",()=>{});' },
  ];
};

let throttledOnce = false;
const searches = [];
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  const url = new URL(req.url, 'http://x');
  const send = (code, data, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600), ...headers }); res.end(JSON.stringify(data)); };
  const p = url.pathname;
  let m;
  if (p === '/rate_limit') {
    return req.headers.authorization?.includes('bad') ? send(401, { message: 'Bad credentials' }) : send(200, { resources: {} });
  }
  if (p === '/repos/o/r/pulls') {
    if (!throttledOnce) { throttledOnce = true; return send(429, { message: 'slow down' }, { 'retry-after': '1' }); }
    return send(200, url.searchParams.get('page') === '1' ? pulls : []);
  }
  if ((m = p.match(/^\/repos\/o\/r\/pulls\/(\d+)\/files$/))) return send(200, files(+m[1]));
  if (p === '/repos/o/r/commits') {
    searches.push(url.searchParams.toString());
    return send(200, url.searchParams.get('author') === 'firstmerge' ? [] : [{ sha: 'old' }]);
  }
  if ((m = p.match(/^\/users\/(.+)$/))) return send(200, { created_at: iso(1000) });
  if (p.startsWith('/repos/o/r/git/trees/')) return send(200, { tree: [{ path: 'package.json', type: 'blob' }] });
  if (p === '/repos/o/r/contents/package.json') return send(200, { type: 'file', encoding: 'base64', content: b64(JSON.stringify({ dependencies: { axios: '1' } })) });
  if (p.startsWith('/repos/o/r/contents/')) return send(404, { message: 'Not Found' });
  if (p.startsWith('/repos/missing/repo/')) return send(404, { message: 'Not Found' });
  send(500, { message: `unhandled ${p}` });
}).listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fairpr-bench-'));
const run = (args, token = 'fake') => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(root, 'bench/fairpr-bench.js'), ...args], {
    env: { PATH: process.env.PATH, GITHUB_TOKEN: token, GITHUB_API_URL: `http://127.0.0.1:${port}`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
  });
  let log = '';
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  c.on('close', (code) => resolve({ code, log }));
});

try {
  let r = await run(['--repos', 'o/r,missing/repo', '--per-repo', '50', '--since', iso(30).slice(0, 10), '--out', out]);
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /slow down; waiting/, 'should wait and retry on 429');
  assert.doesNotMatch(r.log, /rate limit nearly used/, 'search budget must not trigger the main-budget wait');
  assert.match(r.log, /missing\/repo: .*skipping repo|could not list PRs/, r.log);
  const rows = fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 9, 'maintainer, bot, old PRs and returning contributors are excluded');
  assert.ok(rows.some((x) => x.number === 12 && x.group === 'merged'), 'first merged PR of a now-"contributor" is counted');
  assert.ok(!rows.some((x) => x.number === 13), 'returning contributors are not counted');
  assert.equal(searches.length, 2);
  assert.match(searches[0], /author=firstmerge/);
  assert.match(searches[0], /until=/);
  const byNum = Object.fromEntries(rows.map((x) => [x.number, x]));
  assert.equal(byNum[1].group, 'merged');
  assert.equal(byNum[1].verdict, 'verified');
  assert.equal(byNum[5].group, 'closed-unmerged');
  assert.equal(byNum[5].verdict, 'quarantine');
  assert.equal(byNum[6].group, 'labeled-low-quality');
  assert.equal(byNum[7].group, 'labeled-low-quality');
  assert.ok(byNum[5].findings.some((f) => f.id === 'unknown-imports' && f.detail.includes('not-a-real-pkg')), 'finding details are recorded');
  console.log('✓ samples first-time PRs (incl. first merged PRs of now-"contributors"), skips bots/maintainers/old PRs');
  console.log('✓ retries after GitHub rate limiting');

  const report = fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8');
  assert.match(report, /\*\*100\.0%\*\* of PRs that maintainers labeled spam\/invalid\/AI slop were put on hold/);
  assert.match(report, /\*\*0\.0%\*\* of PRs that were \*\*merged\*\* were put on hold.*n=5/);
  assert.match(report, /95% CI/);
  assert.match(report, /## Method and limits/);
  console.log('✓ report has headline numbers, confidence intervals and method notes');

  const before = requests + 1; // +1 for the token check
  r = await run(['--repos', 'o/r', '--per-repo', '4', '--out', out, '--since', iso(30).slice(0, 10)]);
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /already have 9, skipping/);
  assert.ok(requests - before <= 1, 'resumed run must not re-download measured PRs');
  console.log('✓ resumes without re-measuring');

  r = await run(['--report-only', '--out', out]);
  assert.equal(r.code, 0, r.log);
  r = await run(['--repos', 'o/r', '--out', out + '-bad'], 'bad-token');
  assert.equal(r.code, 2);
  assert.match(r.log, /GitHub rejected the token/);
  r = await run(['--repos', 'not a repo']);
  assert.equal(r.code, 2);
  console.log('✓ --report-only works and bad input is rejected');
  console.log('\nAll benchmark end-to-end checks passed.');
  console.log('\n----- sample REPORT.md -----\n' + report.split('## By repository')[0]);
} finally {
  server.close();
  fs.rmSync(out, { recursive: true, force: true });
}

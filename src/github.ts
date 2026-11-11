import type { getOctokit } from '@actions/github';
import type { ChangedFile, Manifests, PrContext } from './types';
import { ext } from './files';

type Octokit = ReturnType<typeof getOctokit>;

export interface RepoRef {
  owner: string;
  repo: string;
}

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const RETURNING_ASSOCIATIONS = new Set(['CONTRIBUTOR', ...MAINTAINER_ASSOCIATIONS]);

/** Read a text file from the repo at a given ref. Returns undefined if missing. */
export async function readFile(octokit: Octokit, r: RepoRef, path: string, ref?: string): Promise<string | undefined> {
  try {
    const res = await octokit.rest.repos.getContent({ ...r, path, ref });
    const data = res.data as { type?: string; content?: string; encoding?: string };
    if (data.type !== 'file' || typeof data.content !== 'string') return undefined;
    return Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString('utf8');
  } catch (e) {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  }
}

async function listTree(octokit: Octokit, r: RepoRef, sha: string): Promise<{ path: string; type: string }[]> {
  try {
    const res = await octokit.rest.git.getTree({ ...r, tree_sha: sha });
    return res.data.tree.map((t) => ({ path: t.path ?? '', type: t.type ?? '' }));
  } catch {
    return [];
  }
}

function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
}

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return undefined;
  }
}

/** Requirement line -> distribution name ("requests>=2; python_version<'3.9'" -> "requests"). */
export function reqName(line: string): string | undefined {
  const l = line.split('#')[0].trim();
  if (!l || l.startsWith('-') || l.includes('://')) return undefined;
  const m = l.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m?.[1];
}

/** Very small TOML reader for dependency names in pyproject.toml (PEP 621 + Poetry). */
export function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  // PEP 621: dependencies = [ "x>=1", ... ] and optional-dependencies groups
  for (const arr of text.matchAll(/^\s*[\w-]*dependencies\s*=\s*\[([\s\S]*?)\]/gm)) {
    for (const s of arr[1].matchAll(/["']([^"']+)["']/g)) {
      const n = reqName(s[1]);
      if (n) out.push(n);
    }
  }
  // Optional dependency groups: [project.optional-dependencies] name = ["..."]
  const optSection = text.match(/\[project\.optional-dependencies\]([\s\S]*?)(\n\[|$)/);
  if (optSection) {
    for (const s of optSection[1].matchAll(/["']([^"']+)["']/g)) {
      const n = reqName(s[1]);
      if (n) out.push(n);
    }
  }
  // Poetry / PDM style tables: [tool.poetry.dependencies], [tool.poetry.group.dev.dependencies]
  for (const sec of text.matchAll(/\[tool\.[\w.-]*dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
    for (const line of sec[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (m && m[1].toLowerCase() !== 'python') out.push(m[1]);
    }
  }
  return out;
}

async function loadManifests(octokit: Octokit, r: RepoRef, headSha: string, files: ChangedFile[]): Promise<Manifests> {
  const manifests: Manifests = {};
  const changed = files.filter((f) => f.status !== 'removed').map((f) => f.filename);
  const jsFiles = changed.filter((p) => ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'].includes(ext(p)));
  const pyFiles = changed.filter((p) => ext(p) === 'py');
  const rootTree = jsFiles.length || pyFiles.length ? await listTree(octokit, r, headSha) : [];
  const rootNames = new Set(rootTree.map((t) => t.path));

  // ---- npm: nearest package.json for each changed file, plus the root one
  if (jsFiles.length) {
    const candidates = new Set<string>(['package.json']);
    for (const p of jsFiles) {
      const parts = p.split('/').slice(0, -1);
      for (let i = parts.length; i > 0; i--) candidates.add(`${parts.slice(0, i).join('/')}/package.json`);
    }
    const deps = new Set<string>();
    let found = 0;
    let root: { workspaces?: unknown } | undefined;
    for (const path of [...candidates].slice(0, 20)) {
      const pkg = parseJson<Record<string, unknown>>(await readFile(octokit, r, path, headSha));
      if (!pkg) continue;
      found++;
      if (path === 'package.json') root = pkg;
      if (typeof pkg.name === 'string') deps.add(pkg.name);
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const section = pkg[key];
        if (section && typeof section === 'object') Object.keys(section).forEach((d) => deps.add(d));
      }
    }
    if (found > 0) {
      manifests.npm = deps;
      manifests.npmIncomplete =
        !!root?.workspaces || rootNames.has('pnpm-workspace.yaml') || rootNames.has('lerna.json') || rootNames.has('nx.json') || rootNames.has('turbo.json');
      const tsconfig = parseJson<{ compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: string } }>(
        await readFile(octokit, r, 'tsconfig.json', headSha),
      );
      const aliases = Object.keys(tsconfig?.compilerOptions?.paths ?? {});
      // baseUrl "." or "src" makes bare imports of local folders valid ("components/Button").
      if (tsconfig?.compilerOptions?.baseUrl) {
        for (const t of rootTree) if (t.type === 'tree') aliases.push(`${t.path}/*`);
        if (tsconfig.compilerOptions.baseUrl.replace(/^\.\//, '') === 'src') {
          for (const t of await listTree(octokit, r, `${headSha}:src`)) if (t.type === 'tree') aliases.push(`${t.path}/*`);
        }
      }
      manifests.jsAliases = aliases;
    }
  }

  // ---- python
  if (pyFiles.length) {
    const deps = new Set<string>();
    let sawManifest = false;
    for (const t of rootTree) {
      if (t.type === 'blob' && /^requirements.*\.(txt|in)$/i.test(t.path)) {
        const text = await readFile(octokit, r, t.path, headSha);
        if (text) {
          sawManifest = true;
          text.split('\n').map(reqName).forEach((n) => n && deps.add(n));
        }
      }
    }
    const pyproject = rootNames.has('pyproject.toml') ? await readFile(octokit, r, 'pyproject.toml', headSha) : undefined;
    if (pyproject) {
      sawManifest = true;
      pyprojectDeps(pyproject).forEach((n) => deps.add(n));
    }
    const setupCfg = rootNames.has('setup.cfg') ? await readFile(octokit, r, 'setup.cfg', headSha) : undefined;
    if (setupCfg) {
      const m = setupCfg.match(/install_requires\s*=([\s\S]*?)(\n\S|\n\[|$)/);
      if (m) {
        sawManifest = true;
        m[1].split('\n').map(reqName).forEach((n) => n && deps.add(n));
      }
    }
    if (sawManifest || rootNames.has('setup.py')) {
      manifests.python = deps;
      manifests.pythonIncomplete = rootNames.has('setup.py') || rootNames.has('Pipfile') || rootNames.has('environment.yml');
      const local = new Set<string>();
      const addTree = (tree: { path: string; type: string }[]) => {
        for (const t of tree) {
          if (t.type === 'tree') local.add(t.path);
          else if (t.path.endsWith('.py')) local.add(t.path.slice(0, -3));
        }
      };
      addTree(rootTree);
      if (rootNames.has('src')) addTree(await listTree(octokit, r, `${headSha}:src`));
      // Modules inside the changed files' own folders (scripts importing siblings).
      for (const p of pyFiles) {
        const dir = p.split('/').slice(0, -1).join('/');
        if (dir) addTree(await listTree(octokit, r, `${headSha}:${dir}`));
      }
      manifests.pythonLocalModules = local;
    }
  }
  return manifests;
}

async function countRecentPrs(octokit: Octokit, login: string): Promise<number | undefined> {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19);
    const res = await octokit.rest.search.issuesAndPullRequests({ q: `is:pr author:${login} created:>=${since}`, per_page: 1 });
    return res.data.total_count;
  } catch {
    return undefined; // search rate limits must never break the check
  }
}

async function accountAgeDays(octokit: Octokit, login: string): Promise<number | undefined> {
  try {
    const res = await octokit.rest.users.getByUsername({ username: login });
    return Math.floor((Date.now() - new Date(res.data.created_at).getTime()) / 86_400_000);
  } catch {
    return undefined;
  }
}

export async function buildContext(octokit: Octokit, r: RepoRef, prNumber: number): Promise<{ ctx: PrContext; headSha: string; baseRef: string }> {
  const { data: pr } = await octokit.rest.pulls.get({ ...r, pull_number: prNumber });
  const rawFiles = await octokit.paginate(octokit.rest.pulls.listFiles, { ...r, pull_number: prNumber, per_page: 100 });
  const files: ChangedFile[] = rawFiles.map((f) => ({
    filename: f.filename,
    status: f.status as ChangedFile['status'],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    sha: f.status === 'removed' ? undefined : f.sha,
  }));

  const login = pr.user?.login ?? 'ghost';
  const association = pr.author_association;
  const [age, recent, manifests] = await Promise.all([
    accountAgeDays(octokit, login),
    countRecentPrs(octokit, login),
    loadManifests(octokit, r, pr.head.sha, files),
  ]);

  return {
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    ctx: {
      number: prNumber,
      title: pr.title,
      body: pr.body ?? '',
      author: {
        login,
        accountAgeDays: age,
        isBot: pr.user?.type === 'Bot',
        isMaintainer: MAINTAINER_ASSOCIATIONS.has(association),
        isFirstTimeContributor: !RETURNING_ASSOCIATIONS.has(association),
        prsOpenedLast24h: recent,
      },
      files,
      manifests,
    },
  };
}

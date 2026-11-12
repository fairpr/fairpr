import type { ChangedFile, Manifests } from './types';
import { ext } from './files';

/**
 * Read-only view of a repository at one commit. Implemented by the GitHub API
 * (Action) and by local git (CLI), so both detect dependencies identically.
 */
export interface RepoReader {
  /** File contents, or undefined if the file does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Direct children of a directory ("" = repo root). Empty if missing. */
  list(dir: string): Promise<{ path: string; type: 'blob' | 'tree' | string }[]>;
}

const JS_EXTS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'];

function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
}

export function parseJson<T>(text: string | undefined): T | undefined {
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

/** Small reader for dependency names in pyproject.toml (PEP 621 + Poetry/PDM tables). */
export function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  for (const arr of text.matchAll(/^\s*[\w-]*dependencies\s*=\s*\[([\s\S]*?)\]/gm)) {
    for (const s of arr[1].matchAll(/["']([^"']+)["']/g)) {
      const n = reqName(s[1]);
      if (n) out.push(n);
    }
  }
  const optSection = text.match(/\[project\.optional-dependencies\]([\s\S]*?)(\n\[|$)/);
  if (optSection) {
    for (const s of optSection[1].matchAll(/["']([^"']+)["']/g)) {
      const n = reqName(s[1]);
      if (n) out.push(n);
    }
  }
  for (const sec of text.matchAll(/\[tool\.[\w.-]*dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
    for (const line of sec[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (m && m[1].toLowerCase() !== 'python') out.push(m[1]);
    }
  }
  return out;
}

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

export async function loadManifests(reader: RepoReader, files: ChangedFile[]): Promise<Manifests> {
  const manifests: Manifests = {};
  const changed = files.filter((f) => f.status !== 'removed').map((f) => f.filename);
  const jsFiles = changed.filter((p) => JS_EXTS.includes(ext(p)));
  const pyFiles = changed.filter((p) => ext(p) === 'py');
  if (!jsFiles.length && !pyFiles.length) return manifests;

  const rootTree = await reader.list('');
  const rootNames = new Set(rootTree.map((t) => t.path));

  const localDirs = new Set<string>();
  for (const t of rootTree) if (t.type === 'tree') localDirs.add(t.path);
  if (rootNames.has('src')) for (const t of await reader.list('src')) if (t.type === 'tree') localDirs.add(t.path);
  for (const p of changed) p.split('/').slice(0, -1).forEach((seg) => localDirs.add(seg));
  manifests.localDirs = localDirs;

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
      const pkg = parseJson<Record<string, unknown>>(await reader.read(path));
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
        !!root?.workspaces || ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'].some((n) => rootNames.has(n));
      const tsconfig = parseJson<{ compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: string } }>(await reader.read('tsconfig.json'));
      const aliases = Object.keys(tsconfig?.compilerOptions?.paths ?? {});
      const baseUrl = tsconfig?.compilerOptions?.baseUrl?.replace(/^\.\//, '').replace(/\/$/, '');
      if (baseUrl !== undefined) {
        const dir = baseUrl === '.' ? '' : baseUrl;
        for (const t of dir === '' ? rootTree : await reader.list(dir)) if (t.type === 'tree') aliases.push(`${t.path}/*`);
      }
      manifests.jsAliases = aliases;
    }
  }

  // ---- python
  if (pyFiles.length) {
    const deps = new Set<string>();
    let sawManifest = false;
    // requirements*.txt, following "-r other.txt" / "-c constraints.txt" includes
    const seen = new Set<string>();
    const readReq = async (file: string, depth: number) => {
      if (seen.has(file) || depth > 4) return;
      seen.add(file);
      const text = await reader.read(file);
      if (!text) return;
      sawManifest = true;
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      for (const line of text.split('\n')) {
        const inc = line.trim().match(/^(?:-r|-c|--requirement|--constraint)\s*=?\s*(\S+)/);
        if (inc) await readReq(normalizePath(dir + inc[1]), depth + 1);
        else {
          const n = reqName(line);
          if (n) deps.add(n);
        }
      }
    };
    for (const t of rootTree) {
      if (t.type === 'blob' && /^requirements.*\.(txt|in)$/i.test(t.path)) await readReq(t.path, 0);
    }
    if (rootNames.has('pyproject.toml')) {
      const pyproject = await reader.read('pyproject.toml');
      if (pyproject) {
        sawManifest = true;
        pyprojectDeps(pyproject).forEach((n) => deps.add(n));
      }
    }
    if (rootNames.has('setup.cfg')) {
      const setupCfg = await reader.read('setup.cfg');
      const m = setupCfg?.match(/install_requires\s*=([\s\S]*?)(\n\S|\n\[|$)/);
      if (m) {
        sawManifest = true;
        m[1].split('\n').map(reqName).forEach((n) => n && deps.add(n));
      }
    }
    if (sawManifest || rootNames.has('setup.py')) {
      manifests.python = deps;
      manifests.pythonIncomplete = ['setup.py', 'Pipfile', 'environment.yml'].some((n) => rootNames.has(n));
      const local = new Set<string>();
      const addTree = (tree: { path: string; type: string }[]) => {
        for (const t of tree) {
          if (t.type === 'tree') local.add(t.path);
          else if (t.path.endsWith('.py')) local.add(t.path.slice(0, -3));
        }
      };
      addTree(rootTree);
      localDirs.forEach((d) => local.add(d));
      if (rootNames.has('src')) addTree(await reader.list('src'));
      for (const dir of new Set(pyFiles.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))) {
        addTree(await reader.list(dir));
      }
      manifests.pythonLocalModules = local;
    }
  }
  return manifests;
}

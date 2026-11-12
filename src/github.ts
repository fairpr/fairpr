import type { getOctokit } from '@actions/github';
import type { ChangedFile, PrContext } from './types';
import { loadManifests, type RepoReader } from './manifests';

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

/** RepoReader backed by the GitHub API at a fixed commit. */
export function apiReader(octokit: Octokit, r: RepoRef, sha: string): RepoReader {
  return {
    read: (path) => readFile(octokit, r, path, sha),
    async list(dir) {
      try {
        const res = await octokit.rest.git.getTree({ ...r, tree_sha: dir ? `${sha}:${dir}` : sha });
        return res.data.tree.map((t) => ({ path: t.path ?? '', type: t.type ?? '' }));
      } catch {
        return [];
      }
    },
  };
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
    loadManifests(apiReader(octokit, r, pr.head.sha), files),
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

import * as core from '@actions/core';
import * as github from '@actions/github';
import { parsePolicy, PolicyError, type Policy } from './policy';
import { buildContext, readFile, type RepoRef } from './github';
import { evaluate, shouldSkip } from './engine';
import { COMMENT_MARKER, renderComment } from './render';
import type { Report, Verdict } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const APPROVAL_RE = /<!-- fairpr:approved-by:([\w-]+) -->/;
const LABEL_COLORS: Record<Verdict, string> = { verified: '2da44e', 'needs-info': 'd4a72c', quarantine: '8250df' };
const LABEL_DESCRIPTIONS: Record<Verdict, string> = {
  verified: 'FairPR: follows the contribution policy',
  'needs-info': 'FairPR: contributor needs to fix a few things',
  quarantine: 'FairPR: waiting for a maintainer to look at it',
};

function labelFor(policy: Policy, v: Verdict): string {
  return v === 'verified' ? policy.labels.verified : v === 'needs-info' ? policy.labels.needs_info : policy.labels.quarantine;
}

async function findOurComment(octokit: Octokit, r: RepoRef, issue: number) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...r, issue_number: issue, per_page: 100 });
  return comments.find((c) => c.body?.includes(COMMENT_MARKER));
}

async function upsertComment(octokit: Octokit, r: RepoRef, issue: number, body: string) {
  const existing = await findOurComment(octokit, r, issue);
  if (existing) {
    if (existing.body !== body) await octokit.rest.issues.updateComment({ ...r, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ ...r, issue_number: issue, body });
  }
}

async function ensureLabel(octokit: Octokit, r: RepoRef, name: string, v: Verdict) {
  try {
    await octokit.rest.issues.getLabel({ ...r, name });
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    try {
      await octokit.rest.issues.createLabel({ ...r, name, color: LABEL_COLORS[v], description: LABEL_DESCRIPTIONS[v] });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err; // 422 = created concurrently
    }
  }
}

async function applyLabel(octokit: Octokit, r: RepoRef, issue: number, policy: Policy, verdict: Verdict) {
  const wanted = labelFor(policy, verdict);
  const ours = new Set([policy.labels.verified, policy.labels.needs_info, policy.labels.quarantine]);
  const { data: current } = await octokit.rest.issues.listLabelsOnIssue({ ...r, issue_number: issue, per_page: 100 });
  for (const l of current) {
    if (ours.has(l.name) && l.name !== wanted) {
      await octokit.rest.issues.removeLabel({ ...r, issue_number: issue, name: l.name }).catch(() => undefined);
    }
  }
  if (!current.some((l) => l.name === wanted)) {
    await ensureLabel(octokit, r, wanted, verdict);
    await octokit.rest.issues.addLabels({ ...r, issue_number: issue, labels: [wanted] });
  }
}

async function loadPolicy(octokit: Octokit, r: RepoRef, configPath: string, baseRef: string): Promise<Policy> {
  // SECURITY: the policy is always read from the base branch, never from the PR,
  // so a contributor cannot loosen the rules inside their own pull request.
  const text = await readFile(octokit, r, configPath, baseRef);
  if (!text) core.info(`No ${configPath} on ${baseRef}; using default policy.`);
  const { policy, warnings } = parsePolicy(text);
  warnings.forEach((w) => core.warning(w));
  const modeOverride = core.getInput('mode');
  if (modeOverride) {
    if (!['label', 'comment', 'dry-run'].includes(modeOverride)) throw new PolicyError(`Input "mode" must be label, comment or dry-run.`);
    policy.mode = modeOverride as Policy['mode'];
  }
  return policy;
}

async function writeSummary(report: Report | undefined, prNumber: number, note: string) {
  const s = core.summary.addHeading(`FairPR: PR #${prNumber}`, 3);
  if (report) {
    s.addRaw(`**Verdict:** ${report.verdict}\n\n`);
    if (report.findings.length) {
      s.addTable([
        [{ data: 'Check', header: true }, { data: 'Type', header: true }, { data: 'Result', header: true }],
        ...report.findings.map((f) => [f.id, f.kind, f.title]),
      ]);
    }
  }
  if (note) s.addRaw(`\n${note}\n`);
  await s.write();
}

async function check(octokit: Octokit, r: RepoRef, prNumber: number, configPath: string, approvedBy?: string) {
  const { ctx, baseRef } = await buildContext(octokit, r, prNumber);
  const policy = await loadPolicy(octokit, r, configPath, baseRef);

  const skipped = shouldSkip(ctx, policy);
  if (skipped) {
    core.info(skipped.reason);
    core.setOutput('verdict', 'skipped');
    await writeSummary(undefined, prNumber, `Skipped: ${skipped.reason}`);
    return;
  }

  const report = evaluate(ctx, policy);

  // A maintainer approval sticks across later pushes until the comment is deleted.
  const existing = policy.mode === 'dry-run' ? undefined : await findOurComment(octokit, r, prNumber);
  const approver = approvedBy ?? existing?.body?.match(APPROVAL_RE)?.[1];
  const finalVerdict: Verdict = approver ? 'verified' : report.verdict;

  let body = renderComment({ ...report, verdict: finalVerdict }, policy, ctx.author.login);
  if (approver) {
    body = body.replace(COMMENT_MARKER, `${COMMENT_MARKER}\n<!-- fairpr:approved-by:${approver} -->`);
    body += `\n\n> ✔️ Approved for review by @${approver}.`;
  }

  core.setOutput('verdict', finalVerdict);
  core.info(`Verdict for #${prNumber}: ${finalVerdict} (${report.findings.length} findings)`);
  await writeSummary({ ...report, verdict: finalVerdict }, prNumber, policy.mode === 'dry-run' ? 'Dry-run mode: no comment or label was posted.' : '');

  if (policy.mode === 'dry-run') {
    core.info(body);
    return;
  }
  await upsertComment(octokit, r, prNumber, body);
  if (policy.mode === 'label') await applyLabel(octokit, r, prNumber, policy, finalVerdict);

  if (finalVerdict === 'quarantine' && core.getBooleanInput('fail-on-quarantine')) {
    core.setFailed('FairPR placed this PR on hold. See the PR comment for details.');
  }
}

async function handleCommand(octokit: Octokit, r: RepoRef, configPath: string) {
  const payload = github.context.payload;
  const issue = payload.issue;
  const comment = payload.comment;
  if (!issue?.pull_request || !comment) return;
  const text = String(comment.body ?? '').trim();
  const commenter = String(comment.user?.login ?? '');
  if (comment.user?.type === 'Bot') return;

  if (/^\/fairpr\s+recheck\b/i.test(text)) {
    await check(octokit, r, issue.number, configPath);
    await octokit.rest.reactions.createForIssueComment({ ...r, comment_id: comment.id, content: 'rocket' }).catch(() => undefined);
    return;
  }

  if (/^\/fairpr\s+approve\b/i.test(text)) {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ ...r, username: commenter });
    if (!['admin', 'maintain', 'write'].includes(data.permission)) {
      await octokit.rest.reactions.createForIssueComment({ ...r, comment_id: comment.id, content: 'confused' }).catch(() => undefined);
      core.info(`@${commenter} does not have write access; ignoring /fairpr approve.`);
      return;
    }
    await check(octokit, r, issue.number, configPath, commenter);
    await octokit.rest.reactions.createForIssueComment({ ...r, comment_id: comment.id, content: '+1' }).catch(() => undefined);
  }
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const configPath = core.getInput('config-path') || '.github/fairpr.yml';
    const octokit = github.getOctokit(token);
    const r: RepoRef = github.context.repo;
    const event = github.context.eventName;

    if (event === 'pull_request_target' || event === 'pull_request') {
      const pr = github.context.payload.pull_request;
      if (!pr) return;
      if (pr.draft) {
        core.info('Draft PR; skipping until it is ready for review.');
        return;
      }
      await check(octokit, r, pr.number, configPath);
    } else if (event === 'issue_comment') {
      await handleCommand(octokit, r, configPath);
    } else {
      core.info(`FairPR does nothing on "${event}" events.`);
    }
  } catch (e) {
    if (e instanceof PolicyError) {
      core.setFailed(`Configuration error: ${e.message}`);
      return;
    }
    // Never block contributors because of our own bugs or API hiccups.
    core.warning(`FairPR could not complete: ${(e as Error).message}`);
  }
}



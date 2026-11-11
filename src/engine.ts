import type { Finding, PrContext, Report, Verdict } from './types';
import type { Policy } from './policy';
import { CHECKS } from './checks';
import { verifyProof } from './proof';

export interface SkipDecision {
  skip: true;
  reason: string;
}

/** Decide whether this PR should be checked at all. */
export function shouldSkip(ctx: PrContext, policy: Policy): SkipDecision | undefined {
  const login = ctx.author.login.toLowerCase();
  if (ctx.author.isBot || login.endsWith('[bot]')) return { skip: true, reason: `@${ctx.author.login} is a bot.` };
  if (policy.allowlist.some((u) => u.toLowerCase() === login)) return { skip: true, reason: `@${ctx.author.login} is on the allowlist.` };
  if (policy.skip_maintainers && ctx.author.isMaintainer) return { skip: true, reason: `@${ctx.author.login} is a maintainer.` };
  if (policy.skip_returning_contributors && !ctx.author.isFirstTimeContributor) {
    return { skip: true, reason: `@${ctx.author.login} already has merged contributions here.` };
  }
  return undefined;
}

/**
 * Verdict rules (simple and explainable on purpose):
 *  - quarantine: 2+ signals, or 1 signal together with a policy problem, or spray behaviour
 *  - needs-info: any policy problem, or exactly 1 signal
 *  - verified:   no policy problems and no signals (hints never change the verdict)
 */
export function decide(findings: Finding[]): Verdict {
  const signals = findings.filter((f) => f.kind === 'signal');
  const policy = findings.filter((f) => f.kind === 'policy');
  if (signals.length >= 2 || (signals.length >= 1 && policy.length >= 1) || signals.some((s) => s.id === 'spray')) {
    return 'quarantine';
  }
  if (policy.length > 0 || signals.length === 1) return 'needs-info';
  return 'verified';
}

export function evaluate(ctx: PrContext, policy: Policy): Report {
  const findings: Finding[] = [];
  const passed: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const check of CHECKS) {
    try {
      const r = check.run(ctx, policy);
      if ('skip' in r) skipped.push({ id: check.id, reason: r.skip });
      else if (r.findings.length === 0) passed.push(check.id);
      else findings.push(...r.findings);
    } catch (e) {
      // A bug in one check must never block a contributor.
      skipped.push({ id: check.id, reason: `Internal error: ${(e as Error).message}` });
    }
  }

  const proof = verifyProof(ctx.body, ctx.files);
  if (proof.present && !proof.valid) {
    findings.push({
      id: 'proof', kind: 'hint',
      title: 'Self-check proof is out of date',
      detail: proof.reason ?? 'The proof could not be verified.',
      fix: 'Run the ProofPR self-check again and paste the new result into the description.',
    });
  }

  return { verdict: decide(findings), findings, passed, skipped, proof };
}

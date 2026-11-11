import { createHash } from 'crypto';
import type { ChangedFile, ProofResult } from './types';

/**
 * A proof fingerprint identifies the exact content of the PR: the git blob SHA
 * of every changed file at the PR head (or "deleted"). The contributor CLI
 * computes it locally with `git rev-parse HEAD:<path>`; the Action recomputes
 * it from the GitHub API. If even one byte changes after the self-check, the
 * fingerprints differ and the proof is rejected.
 */
export function fingerprint(files: Pick<ChangedFile, 'filename' | 'status' | 'sha'>[]): string {
  const lines = files
    .map((f) => `${f.filename}\t${f.status === 'removed' ? 'deleted' : f.sha ?? 'unknown'}`)
    .sort();
  return 'sha256:' + createHash('sha256').update(lines.join('\n')).digest('hex');
}

const PROOF_RE = /<!--\s*proofpr:proof\s+v1\s+fingerprint:\s*(sha256:[a-f0-9]{64})\s*-->/i;

export function extractProof(body: string): string | undefined {
  return body.match(PROOF_RE)?.[1];
}

export function proofMarker(fp: string): string {
  return `<!-- proofpr:proof v1 fingerprint: ${fp} -->`;
}

export function verifyProof(body: string, files: ChangedFile[]): ProofResult {
  const claimed = extractProof(body);
  if (!claimed) return { present: false, valid: false };
  if (files.some((f) => f.status !== 'removed' && !f.sha)) {
    return { present: true, valid: false, reason: 'Could not read file versions to verify the proof.' };
  }
  const actual = fingerprint(files);
  if (claimed === actual) return { present: true, valid: true };
  return {
    present: true,
    valid: false,
    reason: 'The code changed after the self-check was run. Run the self-check again and update the description.',
  };
}

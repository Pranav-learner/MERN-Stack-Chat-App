/**
 * @module trust/migration
 *
 * Migration helpers for the trust layer.
 *
 * ## No destructive migration
 * Sprint 3 introduces two NEW collections (`verifications`, `identitychanges`) and
 * does not modify any existing schema. Existing documents are untouched.
 *
 * ## Fingerprint stability
 * Fingerprints and safety numbers are pure functions of public identity keys, so
 * there is nothing to backfill: they are recomputed on demand and are stable
 * unless the underlying identity key changes (which the trust layer detects).
 */

/** Current trust storage schema version (for future forward-migrations). */
export const TRUST_SCHEMA_VERSION = 1;

/**
 * Read-only adoption report: how many verifications a user has and how many carry
 * detected changes. Useful operational visibility; performs no writes.
 *
 * @param {object} params
 * @param {object} params.trustManager a {@link TrustManager}
 * @param {string} params.userId
 * @returns {Promise<{ verifications: number, byState: Record<string, number>, withWarnings: number }>}
 */
export async function verificationReport({ trustManager, userId }) {
  const list = await trustManager.listVerifications(userId);
  const byState = {};
  for (const v of list) byState[v.trustState] = (byState[v.trustState] ?? 0) + 1;
  const changes = await trustManager.getChanges(userId);
  return { verifications: list.length, byState, withWarnings: changes.length };
}

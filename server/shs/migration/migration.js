/**
 * @module shs/migration
 *
 * Migration helpers for the Secure Handshake System.
 *
 * ## No destructive migration
 * Sprint 1 introduces ONE new collection (`handshakesessions`) and modifies no
 * existing schema. Existing documents are untouched. There is nothing to backfill —
 * sessions are created on demand.
 *
 * ## Housekeeping
 * Handshake sessions are ephemeral. {@link sweepStaleSessions} is an operational
 * helper that expires sessions whose deadline has passed but were never terminated
 * (e.g. a client vanished). It is safe to run periodically; it performs guarded
 * state transitions through the manager, never raw deletes.
 */

/** Current SHS storage schema version (for future forward-migrations). */
export const SHS_SCHEMA_VERSION = 1;

/**
 * Read-only adoption report for a user: how many handshakes they are a party to,
 * grouped by state. Performs no writes.
 *
 * @param {object} params
 * @param {object} params.handshakeManager a {@link HandshakeManager}
 * @param {string} params.userId
 * @returns {Promise<{ total: number, byState: Record<string, number>, active: number }>}
 */
export async function handshakeReport({ handshakeManager, userId }) {
  const list = await handshakeManager.listSessions(userId);
  const byState = {};
  let active = 0;
  for (const s of list) {
    byState[s.state] = (byState[s.state] ?? 0) + 1;
    if (s.isActive) active++;
  }
  return { total: list.length, byState, active };
}

/**
 * Expire any active sessions whose deadline has elapsed. Delegates to the manager
 * so the transition is validated and events fire. Intended for a periodic sweep.
 *
 * @param {object} params
 * @param {object} params.handshakeManager
 * @returns {Promise<{ expired: number, handshakeIds: string[] }>}
 */
export async function sweepStaleSessions({ handshakeManager }) {
  return handshakeManager.sweepExpired();
}

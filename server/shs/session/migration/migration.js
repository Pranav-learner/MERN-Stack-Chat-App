/**
 * @module shs/session/migration
 *
 * Migration helpers for the Secure Session subsystem.
 *
 * ## No destructive migration
 * Sprint 3 introduces ONE new server collection (`securesessions`, metadata only) and
 * modifies no existing schema. Existing documents are untouched. No secret material
 * is stored server-side, so there is nothing secret to migrate.
 *
 * ## Housekeeping
 * {@link sweepExpiredSessions} expires active sessions past their hard lifetime. Safe
 * to run periodically as a cleanup hook.
 */

/** Current session storage schema version (for future forward-migrations). */
export const SESSION_SCHEMA_VERSION = 1;

/**
 * Read-only adoption report for a user: how many sessions they participate in,
 * grouped by status. Performs no writes and reveals no secrets.
 *
 * @param {object} params
 * @param {object} params.sessionManager a {@link SecureSessionManager}
 * @param {string} params.userId
 * @returns {Promise<{ total: number, byState: Record<string, number>, active: number }>}
 */
export async function sessionReport({ sessionManager, userId }) {
  const list = await sessionManager.listSessions(userId);
  const byState = {};
  let active = 0;
  for (const s of list) {
    byState[s.status] = (byState[s.status] ?? 0) + 1;
    if (s.isActive) active++;
  }
  return { total: list.length, byState, active };
}

/**
 * Expire active sessions past their hard lifetime. Delegates to the manager so each
 * transition is guarded and emits an event.
 * @param {object} params @param {object} params.sessionManager
 * @returns {Promise<{ expired: number, sessionIds: string[] }>}
 */
export async function sweepExpiredSessions({ sessionManager }) {
  return sessionManager.sweepExpired();
}

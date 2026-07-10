/**
 * @module shs/key-agreement/migration
 *
 * Migration helpers for the Secure Key Agreement subsystem.
 *
 * ## No destructive migration
 * Sprint 2 introduces ONE new server collection (`keyexchanges`, PUBLIC only) and
 * additively extends the SHS handshake state machine. No existing schema is modified;
 * existing documents are untouched. Shared secrets and session material are NOT
 * stored server-side, so there is nothing secret to migrate or back-fill.
 *
 * ## Housekeeping
 * {@link sweepExpiredExchanges} fails key-exchange records whose deadline elapsed but
 * never established. Safe to run periodically.
 */

/** Current key-agreement storage schema version (for future forward-migrations). */
export const KEY_AGREEMENT_SCHEMA_VERSION = 1;

/**
 * Read-only adoption report for a user: how many key exchanges they are a party to,
 * grouped by state. Performs no writes and reveals no secrets.
 *
 * @param {object} params
 * @param {object} params.keyAgreementManager a {@link KeyAgreementManager}
 * @param {string} params.userId
 * @returns {Promise<{ total: number, byState: Record<string, number>, established: number }>}
 */
export async function keyAgreementReport({ keyAgreementManager, userId }) {
  const list = await keyAgreementManager.listExchanges(userId);
  const byState = {};
  let established = 0;
  for (const e of list) {
    byState[e.state] = (byState[e.state] ?? 0) + 1;
    if (e.state === "established") established++;
  }
  return { total: list.length, byState, established };
}

/**
 * Fail any active key-exchange records past their deadline. Delegates to the manager
 * so the transition is guarded and events fire.
 * @param {object} params @param {object} params.keyAgreementManager
 * @returns {Promise<{ failed: number, handshakeIds: string[] }>}
 */
export async function sweepExpiredExchanges({ keyAgreementManager }) {
  return keyAgreementManager.sweepExpired();
}

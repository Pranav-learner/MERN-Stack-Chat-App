/**
 * @module device-trust/policies/trustPolicy
 *
 * The device trust state machine and evaluation rules. Future modules (Secure
 * Handshake, Sessions) MUST consult {@link canEstablishSession} before creating a
 * secure session with a device — this is the single source of truth for "is this
 * device trusted right now?".
 */

import { TrustStatus } from "../types.js";
import { InvalidTrustTransitionError } from "../errors.js";

/** Default inactivity window before a trusted device is considered expired (30 days). */
export const DEFAULT_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Allowed transitions between stored trust states.
 * REVOKED is terminal. UNKNOWN is never stored.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [TrustStatus.PENDING]: [TrustStatus.TRUSTED, TrustStatus.REVOKED, TrustStatus.BLOCKED],
  [TrustStatus.TRUSTED]: [
    TrustStatus.INACTIVE,
    TrustStatus.EXPIRED,
    TrustStatus.REVOKED,
    TrustStatus.BLOCKED,
  ],
  [TrustStatus.INACTIVE]: [TrustStatus.TRUSTED, TrustStatus.REVOKED, TrustStatus.BLOCKED],
  [TrustStatus.EXPIRED]: [TrustStatus.TRUSTED, TrustStatus.REVOKED, TrustStatus.BLOCKED],
  [TrustStatus.BLOCKED]: [TrustStatus.TRUSTED, TrustStatus.REVOKED],
  [TrustStatus.REVOKED]: [],
});

/**
 * Whether a device may transition from `from` to `to`.
 * @param {string} from current trust status
 * @param {string} to target trust status
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true; // idempotent no-op
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Assert a transition is legal.
 * @param {string} from
 * @param {string} to
 * @throws {InvalidTrustTransitionError}
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidTrustTransitionError(`Cannot transition device from "${from}" to "${to}"`, {
      details: { from, to },
    });
  }
}

/**
 * Whether a device is effectively trusted *right now* (trusted and not idle past
 * the inactivity window). Does not mutate the record.
 * @param {{ trustStatus: string, lastActive?: string|Date|number }} device
 * @param {{ now?: number, inactivityMs?: number }} [options]
 * @returns {boolean}
 */
export function isTrusted(device, options = {}) {
  return effectiveStatus(device, options) === TrustStatus.TRUSTED;
}

/**
 * Compute the *effective* trust status, applying inactivity expiry on top of the
 * stored status. A stored `TRUSTED` device that has been idle beyond the window
 * evaluates to `EXPIRED` (the caller may choose to persist that).
 * @param {{ trustStatus: string, lastActive?: string|Date|number }} device
 * @param {{ now?: number, inactivityMs?: number }} [options]
 * @returns {string} a {@link TrustStatus}
 */
export function effectiveStatus(device, options = {}) {
  const now = options.now ?? Date.now();
  const inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  if (device.trustStatus !== TrustStatus.TRUSTED) return device.trustStatus;
  const last = toMillis(device.lastActive);
  if (last !== null && now - last >= inactivityMs) return TrustStatus.EXPIRED;
  return TrustStatus.TRUSTED;
}

/**
 * Structured "can this device start a secure session?" decision. Future secure
 * messaging layers call this and MUST honour `ok === false`.
 * @param {{ trustStatus: string, lastActive?: string|Date|number }} device
 * @param {{ now?: number, inactivityMs?: number }} [options]
 * @returns {{ ok: boolean, status: string, reason?: string }}
 * @example
 * const decision = canEstablishSession(device);
 * if (!decision.ok) throw new Error(`device not usable: ${decision.reason}`);
 */
export function canEstablishSession(device, options = {}) {
  if (!device) return { ok: false, status: TrustStatus.UNKNOWN, reason: "unknown-device" };
  const status = effectiveStatus(device, options);
  if (status === TrustStatus.TRUSTED) return { ok: true, status };
  return { ok: false, status, reason: `device-${status}` };
}

function toMillis(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * @module shs/session/expiration
 *
 * Expiration policies for Secure Sessions. Pure functions (no timers, no I/O) that
 * the manager and validators use to decide whether a session has exceeded its
 * **maximum lifetime** or its **idle timeout**, plus activity-tracking helpers and a
 * cleanup-selection helper. Automatic rotation is a future hook (see the manager's
 * rekey framework).
 */

/**
 * Whether a session has passed its hard maximum-lifetime deadline.
 * @param {object} session @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isLifetimeExpired(session, now = Date.now()) {
  if (!session?.expiresAt) return false;
  return new Date(session.expiresAt).getTime() <= now;
}

/**
 * Whether a session has been idle longer than its idle timeout.
 * @param {object} session @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isIdleExpired(session, now = Date.now()) {
  if (!session?.idleTimeoutMs || !session?.lastActivityAt) return false;
  return now - new Date(session.lastActivityAt).getTime() >= session.idleTimeoutMs;
}

/**
 * Whether the session should be considered expired (hard lifetime reached).
 * Idle-timeout maps to the IDLE state, not EXPIRED (see {@link shouldGoIdle}).
 * @param {object} session @param {number} [now]
 * @returns {boolean}
 */
export function isExpired(session, now = Date.now()) {
  return isLifetimeExpired(session, now);
}

/**
 * Whether an ACTIVE session should transition to IDLE (idle timeout elapsed but the
 * hard lifetime has not).
 * @param {object} session @param {number} [now]
 * @returns {boolean}
 */
export function shouldGoIdle(session, now = Date.now()) {
  return session?.status === "active" && !isLifetimeExpired(session, now) && isIdleExpired(session, now);
}

/** Milliseconds until the hard expiry (>= 0), or Infinity if none. */
export function remainingLifetimeMs(session, now = Date.now()) {
  if (!session?.expiresAt) return Infinity;
  return Math.max(0, new Date(session.expiresAt).getTime() - now);
}

/**
 * An updated `lastActivityAt` + `expiresAt`-preserving activity stamp. Does NOT
 * extend the hard lifetime; it only refreshes the idle clock.
 * @param {number} [now=Date.now()]
 * @returns {{ lastActivityAt: string }}
 */
export function activityStamp(now = Date.now()) {
  return { lastActivityAt: new Date(now).toISOString() };
}

/**
 * Select sessions eligible for cleanup: any active-family session whose hard lifetime
 * has elapsed. Used by the manager's `sweepExpired` cleanup hook.
 * @param {object[]} sessions @param {number} [now]
 * @returns {object[]}
 */
export function selectExpired(sessions, now = Date.now()) {
  const ACTIVE = new Set(["created", "active", "idle", "paused", "resumed"]);
  return sessions.filter((s) => ACTIVE.has(s.status) && isLifetimeExpired(s, now));
}

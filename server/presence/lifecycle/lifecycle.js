/**
 * @module presence/lifecycle
 *
 * The deterministic finite state machine governing a device's presence status. Defines the
 * legal transitions between {@link PresenceStatus}es and validates every transition the
 * {@link module:presence/manager} performs. Pure logic — no I/O, no crypto, no transport.
 *
 * Unlike a discovery session, presence is **cyclic**: a device goes offline and comes back,
 * so there are no truly terminal states — `OFFLINE` / `EXPIRED` are *resting* states a fresh
 * registration or heartbeat can revive. The FSM still forbids nonsensical jumps (e.g.
 * `OFFLINE → BUSY` without re-registering, or `EXPIRED → DISCONNECTED`).
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> unknown
 *   unknown --> online
 *   unknown --> away
 *   unknown --> busy
 *   unknown --> invisible
 *   online --> away
 *   online --> busy
 *   online --> invisible
 *   online --> disconnected
 *   online --> offline
 *   online --> expired
 *   away --> online
 *   busy --> online
 *   invisible --> online
 *   disconnected --> reconnecting
 *   disconnected --> online
 *   disconnected --> offline
 *   disconnected --> expired
 *   reconnecting --> online
 *   reconnecting --> disconnected
 *   reconnecting --> offline
 *   reconnecting --> expired
 *   expired --> online
 *   offline --> online
 * ```
 */

import { PresenceStatus, ALL_PRESENCE_STATUSES } from "../types/types.js";
import { InvalidPresenceTransitionError } from "../errors.js";

/** The four connected/reachable statuses a user can freely switch among. */
const CONNECTED = [PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.INVISIBLE];

/**
 * Legal transitions keyed by source status. Presence is cyclic, so `OFFLINE`/`EXPIRED` are
 * resting (not terminal) — they transition back up on re-register/heartbeat.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_PRESENCE_TRANSITIONS = Object.freeze({
  // Initial / indeterminate → any connected status (registration).
  [PresenceStatus.UNKNOWN]: [...CONNECTED, PresenceStatus.OFFLINE],
  // Connected statuses can switch among themselves and drop to disconnected/offline/expired.
  [PresenceStatus.ONLINE]: [PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.INVISIBLE, PresenceStatus.DISCONNECTED, PresenceStatus.OFFLINE, PresenceStatus.EXPIRED],
  [PresenceStatus.AWAY]: [PresenceStatus.ONLINE, PresenceStatus.BUSY, PresenceStatus.INVISIBLE, PresenceStatus.DISCONNECTED, PresenceStatus.OFFLINE, PresenceStatus.EXPIRED],
  [PresenceStatus.BUSY]: [PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.INVISIBLE, PresenceStatus.DISCONNECTED, PresenceStatus.OFFLINE, PresenceStatus.EXPIRED],
  [PresenceStatus.INVISIBLE]: [PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.DISCONNECTED, PresenceStatus.OFFLINE, PresenceStatus.EXPIRED],
  // Unclean drop → reconnect attempt, direct recovery, clean offline, or expiry.
  [PresenceStatus.DISCONNECTED]: [PresenceStatus.RECONNECTING, PresenceStatus.ONLINE, PresenceStatus.OFFLINE, PresenceStatus.EXPIRED],
  // Actively restoring → recovered (online), dropped again, offline, or expiry.
  [PresenceStatus.RECONNECTING]: [PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.INVISIBLE, PresenceStatus.DISCONNECTED, PresenceStatus.OFFLINE, PresenceStatus.EXPIRED],
  // Resting states revive to online (via a fresh heartbeat / re-registration).
  [PresenceStatus.EXPIRED]: [PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.INVISIBLE, PresenceStatus.RECONNECTING],
  [PresenceStatus.OFFLINE]: [PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.INVISIBLE],
});

/** Whether `from -> to` is a legal presence transition (a self-transition is always allowed). */
export function canPresenceTransition(from, to) {
  if (from === to) return true; // idempotent refresh (e.g. online → online heartbeat)
  return (ALLOWED_PRESENCE_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidPresenceTransitionError} */
export function assertPresenceTransition(from, to) {
  if (!ALL_PRESENCE_STATUSES.includes(to)) {
    throw new InvalidPresenceTransitionError(`Unknown presence status "${to}"`, { details: { from, to } });
  }
  if (!canPresenceTransition(from, to)) {
    throw new InvalidPresenceTransitionError(`Cannot transition presence from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_PRESENCE_TRANSITIONS[from] ?? [] },
    });
  }
}

/** Statuses reachable in one legal step from `status`. @returns {string[]} */
export function nextPresenceStatuses(status) {
  return [...(ALLOWED_PRESENCE_TRANSITIONS[status] ?? [])];
}

/**
 * A small stateful wrapper for driving one device's presence status + recording history.
 * Holds no I/O; the manager persists the state.
 *
 * @example
 * ```js
 * const fsm = new PresenceLifecycle(PresenceStatus.UNKNOWN);
 * fsm.transition(PresenceStatus.ONLINE);
 * fsm.transition(PresenceStatus.AWAY, { reason: "idle" });
 * fsm.status; // "away"
 * ```
 */
export class PresenceLifecycle {
  /** @param {string} [initial=PresenceStatus.UNKNOWN] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = PresenceStatus.UNKNOWN, options = {}) {
    if (!ALL_PRESENCE_STATUSES.includes(initial)) {
      throw new InvalidPresenceTransitionError(`Unknown initial presence status "${initial}"`, { details: { initial } });
    }
    this._status = initial;
    this._clock = options.clock ?? (() => Date.now());
    this._history = options.history ? [...options.history] : [];
  }

  /** @returns {string} */
  get status() {
    return this._status;
  }
  /** @returns {object[]} */
  get history() {
    return [...this._history];
  }
  /** @returns {string[]} */
  get next() {
    return nextPresenceStatuses(this._status);
  }

  /** Whether a transition to `to` is currently legal. @returns {boolean} */
  can(to) {
    return canPresenceTransition(this._status, to);
  }

  /**
   * Perform a transition, recording it in history. A same-status refresh is a no-op that still
   * appends history (so heartbeats are auditable).
   * @param {string} to @param {{ reason?: string }} [meta]
   * @returns {string} the new status @throws {InvalidPresenceTransitionError}
   */
  transition(to, meta = {}) {
    assertPresenceTransition(this._status, to);
    const entry = { from: this._status, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._status = to;
    return this._status;
  }
}

/**
 * @module group-communication/delivery
 *
 * **Delivery record model + fan-out leg lifecycle.** A fan-out plan is a set of DELIVERY LEGS — one per
 * target device. This module owns the leg record shape and the validated state machine a leg moves
 * through (`planned → queued/dispatched → delivered/failed`), plus a duplicate-delivery guard so the
 * same (message, device) is never delivered twice. It records delivery metadata only — never ciphertext
 * or keys — and is the seam the future Sprint-4 read-receipt engine reads.
 *
 * Pure functions, no I/O.
 */

import { GroupDeliveryState, GROUP_DELIVERY_TRANSITIONS, DeliveryPriority } from "../types/types.js";
import { InvalidFanoutPlanError, DuplicateDeliveryError } from "../errors.js";

/** Whether a leg transition is legal. */
export function canLegTransition(from, to) {
  if (from === to) return true;
  return (GROUP_DELIVERY_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a leg transition is legal. @throws {InvalidFanoutPlanError} */
export function assertLegTransition(from, to) {
  if (!canLegTransition(from, to)) throw new InvalidFanoutPlanError(`Cannot transition delivery from "${from}" to "${to}"`, { details: { from, to } });
  return true;
}

/** A stable dedupe key for a (message, device) delivery. */
export function deliveryKey(messageId, deviceId) {
  return `${messageId}::${deviceId}`;
}

/**
 * Build a delivery leg. @param {object} params
 * @param {string} params.memberId @param {string} params.deviceId @param {boolean} params.online
 * @param {string} [params.priority] @param {string} [params.state] @returns {import("../types/types.js").FanoutLeg}
 */
export function createLeg(params) {
  const online = !!params.online;
  return {
    memberId: String(params.memberId),
    deviceId: String(params.deviceId),
    online,
    priority: params.priority ?? DeliveryPriority.NORMAL,
    state: params.state ?? (online ? GroupDeliveryState.PLANNED : GroupDeliveryState.QUEUED),
    attempts: 0,
    messageRef: null,
    lastError: null,
    updatedAt: null,
  };
}

/** Transition a leg to a new state (validated), returning a NEW leg. */
export function transitionLeg(leg, toState, patch = {}, at = new Date().toISOString()) {
  assertLegTransition(leg.state, toState);
  return { ...leg, ...patch, state: toState, updatedAt: at };
}

/**
 * A duplicate-delivery guard: a bounded set of delivered (message, device) keys. Rejects a re-delivery
 * of the same leg (at-most-once per device). Mirrors the Layer 8 duplicate cache.
 */
export class DeliveryGuard {
  constructor(limit = 100_000) {
    this._seen = new Set();
    this._order = [];
    this._limit = limit;
  }
  /** Mark a (message, device) delivered. @throws {DuplicateDeliveryError} if already delivered. */
  mark(messageId, deviceId) {
    const key = deliveryKey(messageId, deviceId);
    if (this._seen.has(key)) throw new DuplicateDeliveryError("This message was already delivered to this device", { details: { messageId, deviceId } });
    this._seen.add(key);
    this._order.push(key);
    if (this._order.length > this._limit) this._seen.delete(this._order.shift());
    return true;
  }
  /** Whether a (message, device) was already delivered. */
  has(messageId, deviceId) {
    return this._seen.has(deliveryKey(messageId, deviceId));
  }
}

/** Summarize a set of legs by state (for the plan status + audit). */
export function summarizeLegs(legs = []) {
  const byState = {};
  for (const s of Object.values(GroupDeliveryState)) byState[s] = 0;
  for (const leg of legs) byState[leg.state] = (byState[leg.state] ?? 0) + 1;
  return {
    total: legs.length,
    delivered: byState[GroupDeliveryState.DELIVERED],
    dispatched: byState[GroupDeliveryState.DISPATCHED],
    queued: byState[GroupDeliveryState.QUEUED],
    failed: byState[GroupDeliveryState.FAILED],
    skipped: byState[GroupDeliveryState.SKIPPED],
    byState,
  };
}

export { GroupDeliveryState };

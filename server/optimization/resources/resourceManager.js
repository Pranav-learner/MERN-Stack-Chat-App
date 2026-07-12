/**
 * @module optimization/resources/resourceManager
 *
 * The **Global Resource Manager** (STEP 3) — tracks the platform's ABSTRACT resource budgets (bandwidth,
 * cpu, memory, storage, connection, transfer, queue, execution) and provides allocation RECOMMENDATIONS +
 * accounting. It optimizes GLOBALLY: it knows the total budget and everything currently allocated, so it
 * can tell the scheduler whether a communication fits now, whether a resource is constrained, and how much
 * to grant. It NEVER manages real OS resources — every number is an accounting UNIT; the manager makes
 * recommendations, not kernel calls.
 *
 * @performance O(1) recommend / allocate / release / snapshot over a fixed set of budgets. Reservations
 * are keyed by request id so a release is exact.
 *
 * @security Reasons over abstract budget numbers only. No content.
 */

import { deepFreeze } from "../_fabric.js";
import { ALL_RESOURCE_KINDS, DEFAULT_RESOURCE_BUDGETS, CONSTRAINED_UTILIZATION, OptimizationEventType } from "../types/types.js";
import { InvalidResourcePlanError } from "../errors.js";

export class GlobalResourceManager {
  /**
   * @param {object} [deps]
   * @param {object} [deps.budgets] override the {@link DEFAULT_RESOURCE_BUDGETS}
   * @param {number} [deps.constrainedUtilization] fraction above which a resource is "constrained"
   * @param {import("../events/events.js").OptimizationEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.budgets = { ...DEFAULT_RESOURCE_BUDGETS, ...(deps.budgets ?? {}) };
    this.constrained = deps.constrainedUtilization ?? CONSTRAINED_UTILIZATION;
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    /** @type {Map<string, object>} requestId → allocated cost */
    this._reservations = new Map();
    this._allocated = zero();
  }

  /** A frozen snapshot of every budget: total / allocated / available / utilization + constrained flags. */
  snapshot() {
    const budgets = {};
    const constrained = [];
    for (const kind of ALL_RESOURCE_KINDS) {
      const total = this.budgets[kind] ?? 0;
      const allocated = this._allocated[kind] ?? 0;
      const available = Math.max(0, total - allocated);
      const utilization = total > 0 ? allocated / total : 0;
      if (utilization >= this.constrained) constrained.push(kind);
      budgets[kind] = { total, allocated, available, utilization: round4(utilization) };
    }
    const snap = deepFreeze({ budgets, constrained, reservations: this._reservations.size, at: new Date(this.clock()).toISOString() });
    this.events?.emit(OptimizationEventType.RESOURCES_COLLECTED, { constrained, utilization: Object.fromEntries(ALL_RESOURCE_KINDS.map((k) => [k, budgets[k].utilization])) });
    return snap;
  }

  /**
   * Recommend whether a cost fits now (without reserving). Returns grantability + which kinds constrain it
   * + a recommended (possibly throttled) grant. Pure — no state change.
   * @param {object} cost a {@link ResourceCost}
   * @returns {{ grantable: boolean, constrained: string[], recommended: object, fits: object }}
   */
  recommend(cost = {}) {
    const constrained = [];
    const fits = {};
    const recommended = {};
    for (const kind of ALL_RESOURCE_KINDS) {
      if (kind === "queue") continue; // queue is managed by the scheduler, not per-cost
      const need = cost[kind] ?? 0;
      const total = this.budgets[kind] ?? 0;
      const available = Math.max(0, total - (this._allocated[kind] ?? 0));
      fits[kind] = need <= available;
      if (!fits[kind]) constrained.push(kind);
      recommended[kind] = Math.min(need, available); // throttle to what's available
    }
    return { grantable: constrained.length === 0, constrained, recommended, fits };
  }

  /**
   * Reserve a cost for a request. Idempotent per requestId (re-reserving replaces the prior reservation).
   * Over-allocation is permitted but flagged (the scheduler decides via {@link recommend} first); this
   * keeps accounting honest even under contention.
   * @param {string} requestId @param {object} cost
   * @returns {object} the allocation record
   */
  allocate(requestId, cost = {}) {
    if (!requestId) throw new InvalidResourcePlanError("allocate requires a requestId");
    if (this._reservations.has(requestId)) this.release(requestId); // replace
    const reserved = {};
    for (const kind of ALL_RESOURCE_KINDS) {
      if (kind === "queue") continue;
      const need = cost[kind] ?? 0;
      reserved[kind] = need;
      this._allocated[kind] = (this._allocated[kind] ?? 0) + need;
    }
    this._reservations.set(requestId, reserved);
    const record = deepFreeze({ requestId, reserved, at: new Date(this.clock()).toISOString() });
    this.events?.emit(OptimizationEventType.RESOURCES_ALLOCATED, { requestId, reserved });
    return record;
  }

  /** Release a request's reservation. Safe to call for an unknown id. */
  release(requestId) {
    const reserved = this._reservations.get(requestId);
    if (!reserved) return false;
    for (const kind of ALL_RESOURCE_KINDS) if (reserved[kind] != null) this._allocated[kind] = Math.max(0, (this._allocated[kind] ?? 0) - reserved[kind]);
    this._reservations.delete(requestId);
    return true;
  }

  /** Current concurrent-execution headroom (the `execution` budget minus reservations). */
  executionHeadroom() {
    return Math.max(0, (this.budgets.execution ?? 0) - (this._allocated.execution ?? 0));
  }
}

function zero() {
  return Object.fromEntries(ALL_RESOURCE_KINDS.map((k) => [k, 0]));
}
function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

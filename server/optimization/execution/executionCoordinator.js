/**
 * @module optimization/execution/executionCoordinator
 *
 * The **Execution Coordinator** (STEP 12 "Execute Strategy" / adaptive execution) — owns the optimizer's
 * own execution STATE MACHINE (pending → scheduled/deferred → running → completed/failed) and the ADAPTIVE
 * dispatch loop. `dispatchReady()` drains the scheduler's queues (weighted-fair + aging), reserves the
 * resources for each dispatched item, marks it RUNNING, and hands back the batch for the caller (the
 * Communication Fabric) to actually orchestrate. `complete()` / `fail()` release the reservation, freeing
 * capacity for the next dispatch — which is what makes execution adaptive to resource pressure over time.
 *
 * It does NOT perform the real communication (that stays in the frozen Fabric orchestrator) and does NOT
 * monitor/observe (Sprint 4) — it coordinates STATE + resource lifecycle only.
 *
 * @security Tracks request ids + states + abstract reservations only. No content.
 */

import { ExecutionState, OptimizationEventType } from "../types/types.js";

export class ExecutionCoordinator {
  /**
   * @param {object} deps
   * @param {import("../scheduler/scheduler.js").CommunicationScheduler} deps.scheduler
   * @param {import("../resources/resourceManager.js").GlobalResourceManager} deps.resourceManager
   * @param {import("../events/events.js").OptimizationEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    if (!deps.scheduler || !deps.resourceManager) throw new Error("ExecutionCoordinator requires a scheduler + resourceManager");
    this.scheduler = deps.scheduler;
    this.resourceManager = deps.resourceManager;
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    /** @type {Map<string, object>} requestId → { state, cost, updatedAt } */
    this._states = new Map();
  }

  /** Record a request's initial state after scheduling. */
  register(requestId, { status, cost } = {}) {
    const state = status === "immediate" ? ExecutionState.RUNNING : status === "rejected" ? ExecutionState.CANCELLED : status === "deferred" ? ExecutionState.DEFERRED : ExecutionState.SCHEDULED;
    this._set(requestId, state, cost);
    return state;
  }

  /**
   * Adaptive dispatch — drain ready queued work, reserve resources, mark RUNNING, return the batch.
   * @param {object} [opts] `{ maxConcurrent }`
   * @returns {object[]} dispatched entries (each `{ requestId, cost, ... }`)
   */
  dispatchReady(opts = {}) {
    const dispatched = this.scheduler.dispatch({ maxConcurrent: opts.maxConcurrent, resourceManager: this.resourceManager });
    for (const entry of dispatched) {
      this.resourceManager.allocate(entry.requestId, entry.cost ?? {});
      this._set(entry.requestId, ExecutionState.RUNNING, entry.cost);
    }
    return dispatched;
  }

  /** Mark a running execution completed + release its reservation. */
  complete(requestId) {
    this.resourceManager.release(requestId);
    this._set(requestId, ExecutionState.COMPLETED);
    this.events?.emit(OptimizationEventType.EXECUTION_COMPLETED, { requestId });
  }

  /** Mark a running execution failed + release its reservation. */
  fail(requestId, reason) {
    this.resourceManager.release(requestId);
    this._set(requestId, ExecutionState.FAILED, null, { reason });
    this.events?.emit(OptimizationEventType.EXECUTION_COMPLETED, { requestId, failed: true });
  }

  /** Cancel a pending/scheduled execution (removes it from the scheduler + releases any reservation). */
  cancel(requestId) {
    this.scheduler.remove(requestId);
    this.resourceManager.release(requestId);
    this._set(requestId, ExecutionState.CANCELLED);
  }

  /** The current state of a request. */
  stateOf(requestId) {
    return this._states.get(requestId)?.state ?? null;
  }

  /** A snapshot of state counts. */
  snapshot() {
    const counts = {};
    for (const { state } of this._states.values()) counts[state] = (counts[state] ?? 0) + 1;
    return { tracked: this._states.size, counts };
  }

  _set(requestId, state, cost, extra = {}) {
    this._states.set(requestId, { state, cost: cost ?? this._states.get(requestId)?.cost ?? null, updatedAt: this.clock(), ...extra });
  }
}

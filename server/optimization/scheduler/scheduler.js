/**
 * @module optimization/scheduler/scheduler
 *
 * The **Communication Scheduler** (STEP 4) — decides WHEN a communication runs. Given a QoS decision +
 * analysis + resource snapshot it picks a {@link SchedulingMode} through the pluggable scheduling policies
 * (never a hardcoded conditional), then either lets it run IMMEDIATELY or enqueues it into its isolated,
 * capacity-bounded lane. `dispatch()` is the GLOBAL step: it drains queued work across lanes by
 * WEIGHTED-FAIR selection with starvation-preventing aging, bounded by the execution budget + per-item
 * resource grantability — so the platform is optimized as a whole, not one request at a time.
 *
 * @performance schedule is O(policies); dispatch is O(lanes × picked) with constant-time lane head
 * inspection. Bounded queues; deterministic selection (no randomness).
 *
 * @security Reasons over control-plane descriptors + abstract budgets only. No content.
 */

import { Lane } from "./priorityQueue.js";
import { DEFAULT_SCHEDULING_POLICIES } from "./schedulingPolicies.js";
import { SchedulingMode, ScheduleStatus, ALL_LANES, DEFAULT_LANE_CAPACITY, DEFAULT_QOS_WEIGHTS, OptimizationEventType } from "../types/types.js";
import { QueueOverflowError } from "../errors.js";

export class CommunicationScheduler {
  /**
   * @param {object} [deps]
   * @param {object[]} [deps.policies] scheduling policies (default {@link DEFAULT_SCHEDULING_POLICIES})
   * @param {object} [deps.laneCapacity] per-lane capacity (default {@link DEFAULT_LANE_CAPACITY})
   * @param {object} [deps.weights] lane weights (default {@link DEFAULT_QOS_WEIGHTS})
   * @param {import("../events/events.js").OptimizationEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.policies = deps.policies ?? DEFAULT_SCHEDULING_POLICIES;
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    const cap = { ...DEFAULT_LANE_CAPACITY, ...(deps.laneCapacity ?? {}) };
    const weights = { ...DEFAULT_QOS_WEIGHTS, ...(deps.weights ?? {}) };
    /** @type {Map<string, Lane>} */
    this.lanes = new Map(ALL_LANES.map((name) => [name, new Lane({ name, capacity: cap[name], weight: weights[name], clock: this.clock })]));
  }

  /** Pick the scheduling mode from the policy chain (first policy that commits a mode). */
  _pickMode(bundle) {
    for (const policy of this.policies) {
      let out;
      try {
        out = policy.decide(bundle) ?? {};
      } catch {
        continue;
      }
      if (out.mode) return { mode: out.mode, note: out.note, policyId: policy.id };
    }
    return { mode: SchedulingMode.IMMEDIATE, note: "fallback immediate", policyId: "sched.fallback" };
  }

  /**
   * Schedule a communication.
   * @param {object} item `{ requestId, qos, analysis, resources, window, cost, request, meta }`
   * @returns {import("../types/types.js").SchedulingDecision}
   */
  schedule(item) {
    const { mode, note, policyId } = this._pickMode({ qos: item.qos, analysis: item.analysis, resources: item.resources, request: item.request });
    const now = this.clock();
    const window = item.window ?? null;
    const windowDefers = window?.notBefore != null && window.notBefore > now;

    let status;
    let proceed = false;
    let position = -1;

    if (mode === SchedulingMode.IMMEDIATE && !windowDefers) {
      status = ScheduleStatus.IMMEDIATE;
      proceed = true;
    } else {
      const lane = this.lanes.get(item.qos.lane) ?? this.lanes.get("normal");
      try {
        const entry = lane.enqueue({ requestId: item.requestId, qos: item.qos, analysis: item.analysis, cost: item.cost, window, mode, meta: item.meta });
        position = lane.size - 1;
        status = mode === SchedulingMode.BACKGROUND || windowDefers ? ScheduleStatus.DEFERRED : ScheduleStatus.QUEUED;
      } catch (error) {
        if (error instanceof QueueOverflowError) {
          status = ScheduleStatus.REJECTED;
        } else {
          throw error;
        }
      }
    }

    const decision = { requestId: item.requestId, qosClass: item.qos.qosClass, mode, lane: item.qos.lane, status, window, position, proceed, reason: { policyId, note } };
    const evtType = proceed ? OptimizationEventType.EXECUTION_SCHEDULED : OptimizationEventType.EXECUTION_DEFERRED;
    this.events?.emit(evtType, { requestId: item.requestId, mode, lane: item.qos.lane, status });
    return decision;
  }

  /**
   * Dispatch queued work across lanes — the GLOBAL optimization step. Selects entries by weighted-fair +
   * aged priority, bounded by `maxConcurrent` and per-item resource grantability (via `resourceManager`).
   * Dispatched entries are removed from their lanes + returned.
   * @param {object} [opts] `{ maxConcurrent, resourceManager }`
   * @returns {object[]} dispatched entries
   */
  dispatch(opts = {}) {
    const now = this.clock();
    const headroom = opts.resourceManager ? opts.resourceManager.executionHeadroom() : Infinity;
    const budget = Math.min(opts.maxConcurrent ?? Infinity, headroom === Infinity ? opts.maxConcurrent ?? 64 : headroom);
    const dispatched = [];
    const skipped = new Set(); // requestIds temporarily un-dispatchable (resource / window) — leave queued

    while (dispatched.length < budget) {
      // choose the eligible lane whose head has the highest aged priority
      let bestLane = null;
      let bestPriority = -Infinity;
      for (const lane of this.lanes.values()) {
        const head = lane.peek();
        if (!head || skipped.has(head.requestId)) continue;
        if (head.window?.notBefore != null && head.window.notBefore > now) {
          skipped.add(head.requestId);
          continue;
        }
        const p = lane.effectivePriority(head);
        if (p > bestPriority) {
          bestPriority = p;
          bestLane = lane;
        }
      }
      if (!bestLane) break;

      const head = bestLane.peek();
      // resource gate — if it doesn't fit now, leave it queued and try others
      if (opts.resourceManager) {
        const rec = opts.resourceManager.recommend(head.cost ?? {});
        if (!rec.grantable) {
          skipped.add(head.requestId);
          continue;
        }
      }
      const entry = bestLane.dequeue();
      dispatched.push(entry);
    }

    if (dispatched.length) this.events?.emit(OptimizationEventType.EXECUTION_STARTED, { count: dispatched.length, requestIds: dispatched.map((e) => e.requestId) });
    return dispatched;
  }

  /** Remove a queued item (e.g. cancelled). */
  remove(requestId) {
    for (const lane of this.lanes.values()) {
      const removed = lane.remove(requestId);
      if (removed) return removed;
    }
    return null;
  }

  /** A snapshot of lane depths + total queued. */
  state() {
    const lanes = {};
    let total = 0;
    for (const [name, lane] of this.lanes) {
      lanes[name] = { depth: lane.size, capacity: lane.capacity, weight: lane.weight, headPriority: lane.headPriority() === -Infinity ? null : lane.headPriority() };
      total += lane.size;
    }
    return { lanes, total, at: new Date(this.clock()).toISOString() };
  }
}

/**
 * @module optimization/balancing/workloadBalancer
 *
 * The **Workload Balancer** (STEP 8) — reads the scheduler's lane state + the resource snapshot and
 * balances the platform's workload: it flags saturated lanes, raises graded BACKPRESSURE signals, decides
 * admission for new work (throttle background → normal → shed non-critical), performs adaptive queue
 * selection, and distributes a dispatch batch into parallel-safe groups vs a sequential tail. It optimizes
 * ACROSS queues, not within one — the global-coordination half of the optimizer.
 *
 * @performance O(lanes) balance; O(items) distribution. Pure + deterministic.
 * @security Reasons over queue depths + abstract budgets only. No content.
 * @evolution The balancer is cluster-ready: `node`/`shard` placement is a future field on the balance
 * result (single-node in Sprint 3); Sprint 4+ can distribute across a cluster without changing callers.
 */

import { BackpressureSignal, QoSClass, OptimizationEventType } from "../types/types.js";

const SATURATION = 0.9;

export class WorkloadBalancer {
  /** @param {object} [deps] @param {import("../events/events.js").OptimizationEventBus} [deps.events] */
  constructor(deps = {}) {
    this.events = deps.events ?? null;
    this.saturation = deps.saturation ?? SATURATION;
  }

  /**
   * Balance the current workload.
   * @param {object} schedulerState from {@link CommunicationScheduler#state}
   * @param {object} resourceSnapshot from {@link GlobalResourceManager#snapshot}
   * @returns {{ lanes, totalDepth, totalCapacity, utilization, backpressure, saturatedLanes, node, recommendations }}
   */
  balance(schedulerState, resourceSnapshot = {}) {
    const lanes = {};
    let totalDepth = 0;
    let totalCapacity = 0;
    const saturatedLanes = [];
    for (const [name, s] of Object.entries(schedulerState.lanes ?? {})) {
      const utilization = s.capacity > 0 ? s.depth / s.capacity : 0;
      const saturated = utilization >= this.saturation;
      if (saturated) saturatedLanes.push(name);
      lanes[name] = { depth: s.depth, capacity: s.capacity, utilization: round4(utilization), saturated };
      totalDepth += s.depth;
      totalCapacity += s.capacity;
    }
    const totalUtil = totalCapacity > 0 ? totalDepth / totalCapacity : 0;
    const constrained = resourceSnapshot.constrained ?? [];

    // graded backpressure from queue saturation + resource constraint
    let backpressure = BackpressureSignal.NONE;
    if (totalUtil >= 0.98 || constrained.includes("memory")) backpressure = BackpressureSignal.SHED;
    else if (totalUtil >= this.saturation || constrained.includes("execution")) backpressure = BackpressureSignal.THROTTLE_NORMAL;
    else if (saturatedLanes.length > 0 || constrained.includes("bandwidth")) backpressure = BackpressureSignal.THROTTLE_BACKGROUND;

    const result = {
      lanes,
      totalDepth,
      totalCapacity,
      utilization: round4(totalUtil),
      backpressure,
      saturatedLanes,
      node: "local", // single-node in Sprint 3; cluster placement is a future extension
      recommendations: this._recommendations(backpressure, saturatedLanes),
    };
    this.events?.emit(OptimizationEventType.WORKLOAD_BALANCED, { backpressure, totalDepth, saturatedLanes });
    return result;
  }

  /**
   * Admission decision for NEW work under the current backpressure signal.
   * @param {string} qosClass @param {string} backpressure a {@link BackpressureSignal}
   * @returns {{ accept: boolean, defer: boolean, reason: string }}
   */
  admit(qosClass, backpressure) {
    if (qosClass === QoSClass.CRITICAL) return { accept: true, defer: false, reason: "critical always admitted" };
    switch (backpressure) {
      case BackpressureSignal.SHED:
        return { accept: false, defer: qosClass === QoSClass.HIGH, reason: "shedding non-critical" };
      case BackpressureSignal.THROTTLE_NORMAL:
        return qosClass === QoSClass.BACKGROUND || qosClass === QoSClass.NORMAL ? { accept: true, defer: true, reason: "throttling normal+background" } : { accept: true, defer: false, reason: "high admitted" };
      case BackpressureSignal.THROTTLE_BACKGROUND:
        return qosClass === QoSClass.BACKGROUND ? { accept: true, defer: true, reason: "throttling background" } : { accept: true, defer: false, reason: "admitted" };
      default:
        return { accept: true, defer: false, reason: "no backpressure" };
    }
  }

  /**
   * Adaptive queue selection — normally the QoS lane, but a saturated lane for downgradable (background)
   * work signals deferral. Never downgrades a critical/high class.
   */
  selectLane(qosClass, lane, schedulerState) {
    const laneState = schedulerState.lanes?.[lane];
    const saturated = laneState && laneState.capacity > 0 && laneState.depth / laneState.capacity >= this.saturation;
    return { lane, saturated: !!saturated, defer: !!saturated && qosClass === QoSClass.BACKGROUND };
  }

  /**
   * Distribute a dispatch batch into parallel-safe groups + a sequential tail. Media / heavy-connection
   * items go sequential (resource contention); light items parallelize. Deterministic partition.
   * @param {object[]} items dispatched entries (with `.cost`, `.analysis`)
   * @returns {{ parallel: object[], sequential: object[] }}
   */
  distribute(items = []) {
    const parallel = [];
    const sequential = [];
    for (const item of items) {
      const heavy = item.analysis?.isMedia || item.analysis?.isLarge || (item.cost?.connection ?? 0) > 100;
      (heavy ? sequential : parallel).push(item);
    }
    return { parallel, sequential };
  }

  _recommendations(backpressure, saturatedLanes) {
    const recs = [];
    if (backpressure !== BackpressureSignal.NONE) recs.push({ action: backpressure, scope: "new-work" });
    for (const lane of saturatedLanes) recs.push({ action: "drain", lane });
    return recs;
  }
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

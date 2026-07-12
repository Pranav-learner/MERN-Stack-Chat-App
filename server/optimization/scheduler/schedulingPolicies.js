/**
 * @module optimization/scheduler/schedulingPolicies
 *
 * **Pluggable scheduling policies** (STEP 4) — each decides a {@link SchedulingMode} (and optionally an
 * execution window) for a communication from its QoS decision + analysis + resource snapshot. The
 * scheduler runs them in order and takes the first mode a policy commits to, so "immediate vs deferred vs
 * background vs batch" is a policy decision, NOT a hardcoded conditional in the scheduler. A deployment
 * inserts / reorders / replaces policies freely.
 *
 * A policy: `{ id, describe, decide(bundle) => { mode?, window?, note? } }` where
 * `bundle = { qos, analysis, resources, request }`.
 *
 * @security Reads control-plane analysis + abstract budget numbers only. No content.
 */

import { SchedulingMode, QoSClass } from "../types/types.js";

/** An explicit per-request mode (from the caller / a resource policy) wins. */
export const explicitModePolicy = {
  id: "sched.explicit",
  describe: "Honours an explicit requested scheduling mode.",
  decide({ qos, request }) {
    const mode = request?.mode ?? qos?.mode;
    return mode ? { mode, note: "explicit mode" } : {};
  },
};

/** Critical traffic runs immediately. */
export const criticalImmediatePolicy = {
  id: "sched.critical-immediate",
  describe: "Critical QoS runs immediately.",
  decide({ qos }) {
    return qos?.qosClass === QoSClass.CRITICAL ? { mode: SchedulingMode.IMMEDIATE, note: "critical → immediate" } : {};
  },
};

/** Background traffic is deferred to a background dispatch. */
export const backgroundPolicy = {
  id: "sched.background",
  describe: "Background QoS is deferred.",
  decide({ qos }) {
    return qos?.qosClass === QoSClass.BACKGROUND || qos?.deferBackground ? { mode: SchedulingMode.BACKGROUND, note: "background" } : {};
  },
};

/** Large media is batched. */
export const largeMediaBatchPolicy = {
  id: "sched.large-media-batch",
  describe: "Large media is scheduled as a batch.",
  decide({ analysis }) {
    return analysis?.isLarge && analysis?.isMedia ? { mode: SchedulingMode.BATCH, note: "large media → batch" } : {};
  },
};

/** Under execution/bandwidth pressure, defer non-critical work. */
export const resourcePressurePolicy = {
  id: "sched.resource-pressure",
  describe: "Defers non-critical work when execution/bandwidth are constrained.",
  decide({ qos, resources }) {
    if (qos?.qosClass === QoSClass.CRITICAL) return {};
    const constrained = resources?.constrained ?? [];
    if (constrained.includes("execution") || constrained.includes("bandwidth")) return { mode: SchedulingMode.DEFERRED, note: `resource pressure: ${constrained.join(",")}` };
    return {};
  },
};

/** Default: run immediately. */
export const defaultImmediatePolicy = {
  id: "sched.default",
  describe: "Default scheduling mode is immediate.",
  decide() {
    return { mode: SchedulingMode.IMMEDIATE, note: "default immediate" };
  },
};

/** The default, ordered scheduling-policy chain (first committed mode wins). */
export const DEFAULT_SCHEDULING_POLICIES = Object.freeze([explicitModePolicy, criticalImmediatePolicy, resourcePressurePolicy, largeMediaBatchPolicy, backgroundPolicy, defaultImmediatePolicy]);

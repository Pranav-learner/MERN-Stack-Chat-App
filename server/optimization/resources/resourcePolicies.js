/**
 * @module optimization/resources/resourcePolicies
 *
 * **Adaptive resource policies** (STEP 7) — pluggable hooks that DYNAMICALLY influence scheduling. Each
 * hook reads the communication context + analysis + resource snapshot + config and returns adjustments:
 * a QoS-class override, a scheduling-mode preference, a resource-cap multiplier, or an admission veto.
 * These are the seams the sprint calls out — bandwidth / memory / battery / storage / synchronization /
 * communication / enterprise policies — plus built-ins. A hook NEVER executes anything; it shapes the
 * scheduling decision so the optimizer adapts to pressure.
 *
 * A hook: `{ id, kind, describe, evaluate(ctxBundle) => { qosClass?, mode?, capMultiplier?, deferBackground?, deny?, note? } }`
 * where `ctxBundle = { context, analysis, resources, config }`.
 *
 * @security Hooks read control-plane metadata + abstract budget numbers only. No content.
 */

import { QoSClass, SchedulingMode } from "../types/types.js";

/** **Bandwidth policy** — under bandwidth pressure, push large/media traffic to the background + batch it. */
export const bandwidthPolicy = {
  id: "resource.bandwidth",
  kind: "bandwidth",
  describe: "Defers/batches large or media traffic when bandwidth is constrained.",
  evaluate({ analysis, resources, config = {} }) {
    if (config.bandwidth?.enabled === false) return {};
    const constrained = resources?.constrained?.includes("bandwidth");
    if (constrained && (analysis.isMedia || analysis.isLarge)) return { mode: SchedulingMode.BATCH, deferBackground: true, note: "bandwidth constrained → batch media" };
    return {};
  },
};

/** **Memory policy** — under memory pressure, cap concurrency + defer background work. */
export const memoryPolicy = {
  id: "resource.memory",
  kind: "memory",
  describe: "Caps concurrency and defers background work under memory pressure.",
  evaluate({ resources, config = {} }) {
    if (config.memory?.enabled === false) return {};
    if (resources?.constrained?.includes("memory")) return { capMultiplier: 0.5, deferBackground: true, note: "memory constrained" };
    return {};
  },
};

/** **Battery policy hook** — when enabled, background + batch non-urgent traffic to coalesce the radio. */
export const batteryPolicy = {
  id: "resource.battery",
  kind: "battery",
  describe: "Battery-saver: background/batch non-urgent traffic.",
  evaluate({ analysis, config = {} }) {
    if (!config.battery?.enabled) return {};
    if (analysis.priority === "urgent" || analysis.communicationType === "control") return { note: "battery-saver bypassed for urgent/control" };
    return { mode: SchedulingMode.BACKGROUND, note: "battery-saver active" };
  },
};

/** **Storage policy** — under storage pressure, defer media (which stores blobs) to the background. */
export const storagePolicy = {
  id: "resource.storage",
  kind: "storage",
  describe: "Defers media under storage pressure.",
  evaluate({ analysis, resources, config = {} }) {
    if (config.storage?.enabled === false) return {};
    if (resources?.constrained?.includes("storage") && analysis.isMedia) return { mode: SchedulingMode.DEFERRED, note: "storage constrained → defer media" };
    return {};
  },
};

/** **Synchronization policy** — sync/background traffic yields; it is always background-classed. */
export const synchronizationPolicy = {
  id: "resource.synchronization",
  kind: "synchronization",
  describe: "Classifies synchronization traffic as background.",
  evaluate({ analysis, config = {} }) {
    if (config.synchronization?.enabled === false) return {};
    if (analysis.communicationType === "synchronization" || analysis.isSelf) return { qosClass: QoSClass.BACKGROUND, note: "sync → background" };
    return {};
  },
};

/** **Communication policy** — control/security signalling is critical + immediate. */
export const communicationPolicy = {
  id: "resource.communication",
  kind: "communication",
  describe: "Control/security signalling is critical + immediate.",
  evaluate({ analysis, config = {} }) {
    if (config.communication?.enabled === false) return {};
    if (analysis.communicationType === "control" || analysis.priority === "urgent") return { qosClass: QoSClass.CRITICAL, mode: SchedulingMode.IMMEDIATE, note: "critical signalling" };
    return {};
  },
};

/** **Enterprise policy hook** — org controls: force-background for a class, or cap concurrency globally. */
export const enterprisePolicy = {
  id: "resource.enterprise",
  kind: "enterprise",
  describe: "Enterprise resource controls (force-background / global concurrency cap / admission).",
  evaluate({ analysis, config = {} }) {
    const ent = config.enterprise;
    if (!ent) return {};
    const out = { note: "enterprise resource policy" };
    if (ent.capMultiplier != null) out.capMultiplier = ent.capMultiplier;
    if (ent.backgroundClasses?.includes(analysis.communicationType)) out.mode = SchedulingMode.BACKGROUND;
    if (ent.denyClasses?.includes(analysis.communicationType)) return { deny: true, note: `enterprise policy denies ${analysis.communicationType}` };
    return out;
  },
};

/** The default, ordered adaptive resource-policy set. A deployment adds/removes hooks freely. */
export const DEFAULT_RESOURCE_POLICIES = Object.freeze([communicationPolicy, synchronizationPolicy, bandwidthPolicy, memoryPolicy, storagePolicy, batteryPolicy, enterprisePolicy]);

/**
 * @module optimization/types
 *
 * Enums + constants for **Layer 12 · Sprint 3 — Resource Optimization & Global Coordination.** This is an
 * INDEPENDENT subsystem that sits ABOVE the frozen Sprint-1 Communication Fabric + Sprint-2 Adaptive
 * Routing. Where Sprint 2 optimizes ONE request at a time, Sprint 3 optimizes the platform GLOBALLY:
 * scheduling, QoS, resource allocation, cross-device coordination, workload balancing, and execution
 * planning — WITHOUT modifying any lower communication layer.
 *
 * It REUSES the frozen vocabulary (`CommunicationType`, `Priority`, `RouteKind`, `StrategyType`, the
 * Sprint-1 `ExecutionPlan`) via an internal re-export, and adds only the OPTIMIZATION vocabulary here
 * (QoS classes, scheduling modes, resource kinds, execution states, events).
 *
 * @security The optimizer reasons over communication CONTROL-PLANE metadata + ABSTRACT resource budget
 * UNITS only — never message plaintext, ciphertext, or key material, and never real OS resources. It
 * produces allocation RECOMMENDATIONS + schedules, not kernel calls.
 *
 * @performance Every vocabulary is a frozen table; QoS classification, scheduling, and planning are
 * constant-time table lookups + bounded queue ops, so the optimizer stays fast under many concurrent
 * communications. Pure + synchronous decision paths (no probing / I/O).
 *
 * @evolution Sprint 4 (production hardening / monitoring / observability) CONSUMES this sprint's events +
 * extends its policy/scheduler seams. Runtime auto-tuning + ML are explicitly out of scope this sprint.
 */

// Re-export the frozen lower-layer vocabulary this layer consumes.
export { CommunicationType, ConversationType, MediaType, Priority, StrategyType, RouteKind, SubsystemKind, PRIORITY_RANK } from "../_fabric.js";

// === QoS ===================================================================

/**
 * Quality-of-Service priority classes. Every communication is classified into exactly one; the class
 * determines its queue lane, fairness weight, and starvation-prevention aging rate.
 * @readonly @enum {string}
 */
export const QoSClass = Object.freeze({
  CRITICAL: "critical", // control/security signalling — never queued behind bulk
  HIGH: "high", // user-visible, latency-sensitive
  NORMAL: "normal", // ordinary messages (default)
  BACKGROUND: "background", // sync, analytics, prefetch — yields to everything
});

export const ALL_QOS_CLASSES = Object.freeze(Object.values(QoSClass));

/** QoS rank (higher = more important). Constant-time comparison for fair scheduling. */
export const QOS_RANK = Object.freeze({ critical: 3, high: 2, normal: 1, background: 0 });

/**
 * Weighted-fair-scheduling weights per class — the scheduler dispatches from lanes in proportion to these,
 * so a lower class is served but never starves a higher one. Configurable.
 */
export const DEFAULT_QOS_WEIGHTS = Object.freeze({ critical: 8, high: 4, normal: 2, background: 1 });

/** The queue lane each QoS class maps to (isolated lanes → queue isolation). */
export const QOS_LANE = Object.freeze({ critical: "critical", high: "high", normal: "normal", background: "background" });

export const ALL_LANES = Object.freeze(["critical", "high", "normal", "background"]);

// === scheduling ============================================================

/**
 * How a communication is scheduled for execution. The scheduling policy picks a mode from QoS + analysis
 * + resource availability — no hardcoded conditionals in the scheduler itself.
 * @readonly @enum {string}
 */
export const SchedulingMode = Object.freeze({
  IMMEDIATE: "immediate", // execute now
  DEFERRED: "deferred", // queue for a later dispatch (resources/policy)
  BACKGROUND: "background", // lowest-priority deferred, runs when idle
  BATCH: "batch", // grouped with similar work (e.g. large media)
  PARALLEL: "parallel", // may run concurrently with independent work
  SEQUENTIAL: "sequential", // must run after its predecessors (ordering)
});

export const ALL_SCHEDULING_MODES = Object.freeze(Object.values(SchedulingMode));

/** The outcome of scheduling a communication. @readonly @enum {string} */
export const ScheduleStatus = Object.freeze({
  IMMEDIATE: "immediate", // dispatch now (proceed)
  QUEUED: "queued", // placed in a lane, awaiting dispatch
  DEFERRED: "deferred", // held until a window / resources free up
  REJECTED: "rejected", // refused (queue overflow / policy)
});

export const ALL_SCHEDULE_STATUSES = Object.freeze(Object.values(ScheduleStatus));

// === resources =============================================================

/**
 * The abstract resource budgets the Global Resource Manager tracks. All are UNITS, not real OS resources —
 * the manager provides allocation RECOMMENDATIONS + accounting, never kernel calls.
 * @readonly @enum {string}
 */
export const ResourceKind = Object.freeze({
  BANDWIDTH: "bandwidth",
  CPU: "cpu",
  MEMORY: "memory",
  STORAGE: "storage",
  CONNECTION: "connection",
  TRANSFER: "transfer",
  QUEUE: "queue",
  EXECUTION: "execution",
});

export const ALL_RESOURCE_KINDS = Object.freeze(Object.values(ResourceKind));

/** Default global resource budgets (abstract units). Configurable per deployment. */
export const DEFAULT_RESOURCE_BUDGETS = Object.freeze({
  bandwidth: 1_000_000, // KB-equivalent units
  cpu: 1_000,
  memory: 500_000,
  storage: 5_000_000,
  connection: 10_000,
  transfer: 2_000,
  queue: 10_000,
  execution: 128, // max concurrent executions
});

/** Utilization above this fraction marks a resource "constrained" (throttle / defer new background work). */
export const CONSTRAINED_UTILIZATION = 0.9;

// === execution =============================================================

/** The lifecycle state of an optimized execution (the optimizer's own state machine, not the Fabric's). */
export const ExecutionState = Object.freeze({
  PENDING: "pending", // accepted, not yet scheduled
  SCHEDULED: "scheduled", // placed on the timeline / a lane
  DEFERRED: "deferred", // held (window / resources)
  RUNNING: "running", // dispatched to the Fabric
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const ALL_EXECUTION_STATES = Object.freeze(Object.values(ExecutionState));

// === cross-device coordination =============================================

/** The role a device plays in a coordinated communication. @readonly @enum {string} */
export const DeviceRole = Object.freeze({
  PRIMARY: "primary", // the device that performs the communication
  REPLICA: "replica", // receives a replicated copy (sync)
  SECONDARY: "secondary", // eligible but not selected
});

export const ALL_DEVICE_ROLES = Object.freeze(Object.values(DeviceRole));

/** The coordination facets planned across a user's devices. @readonly @enum {string} */
export const CoordinationKind = Object.freeze({
  DELIVERY: "delivery",
  SYNCHRONIZATION: "synchronization",
  MEDIA: "media",
  EXECUTION: "execution",
});

export const ALL_COORDINATION_KINDS = Object.freeze(Object.values(CoordinationKind));

// === workload balancing ====================================================

/** Backpressure signals the workload balancer raises. @readonly @enum {string} */
export const BackpressureSignal = Object.freeze({
  NONE: "none",
  THROTTLE_BACKGROUND: "throttle-background", // stop admitting background work
  THROTTLE_NORMAL: "throttle-normal", // also throttle normal work
  SHED: "shed", // reject non-critical work (severe)
});

export const ALL_BACKPRESSURE_SIGNALS = Object.freeze(Object.values(BackpressureSignal));

// === events ================================================================

/**
 * Internal optimization event types. **Sprint 4 (production hardening) CONSUMES these** to drive
 * monitoring + observability without modifying this pipeline. Events carry ids + classifications +
 * budget/queue numbers only — never content/keys.
 * @readonly @enum {string}
 */
export const OptimizationEventType = Object.freeze({
  RESOURCES_COLLECTED: "optimization.resources_collected",
  QOS_EVALUATED: "optimization.qos_evaluated",
  POLICIES_EVALUATED: "optimization.policies_evaluated",
  EXECUTION_SCHEDULED: "optimization.execution_scheduled",
  EXECUTION_DEFERRED: "optimization.execution_deferred",
  RESOURCES_ALLOCATED: "optimization.resources_allocated",
  DEVICES_COORDINATED: "optimization.devices_coordinated",
  WORKLOAD_BALANCED: "optimization.workload_balanced",
  EXECUTION_STARTED: "optimization.execution_started",
  EXECUTION_COMPLETED: "optimization.execution_completed",
  OPTIMIZATION_COMPLETED: "optimization.optimization_completed",
});

export const ALL_OPTIMIZATION_EVENT_TYPES = Object.freeze(Object.values(OptimizationEventType));

// === failure reasons =======================================================

/** Machine-readable optimization failure/validation reasons. */
export const OptimizationFailureReason = Object.freeze({
  INVALID_RESOURCE_PLAN: "invalid-resource-plan",
  SCHEDULER_CONFLICT: "scheduler-conflict",
  QOS_CONFLICT: "qos-conflict",
  QUEUE_OVERFLOW: "queue-overflow",
  POLICY_CONFLICT: "policy-conflict",
  INVALID_PLAN: "invalid-plan",
  REPOSITORY_INCONSISTENT: "repository-inconsistent",
  CONFIGURATION_ERROR: "configuration-error",
  UNAUTHORIZED: "unauthorized",
  CONTENT_LEAK: "content-leak",
  INTERNAL_ERROR: "internal-error",
});

// === constants =============================================================

export const OPTIMIZATION_FRAMEWORK = "optimization";
export const OPTIMIZATION_SCHEMA_VERSION = 1;
export const OPTIMIZATION_LAYER = 12;
export const OPTIMIZATION_SPRINT = 3;

/** Default per-lane queue capacity (queue overflow → backpressure / reject). */
export const DEFAULT_LANE_CAPACITY = Object.freeze({ critical: 5_000, high: 4_000, normal: 3_000, background: 2_000 });

/** Aging: a queued item's effective priority rises by this many rank-points per elapsed interval. */
export const DEFAULT_AGING_MS = 5_000;
export const DEFAULT_AGING_STEP = 1;

/** Bounded audit-trail retention per optimization. */
export const MAX_AUDIT_ENTRIES = 100;

/** Pagination bounds. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} ResourceCost Estimated abstract resource cost of one communication.
 * @property {number} bandwidth @property {number} cpu @property {number} memory @property {number} storage
 * @property {number} connection @property {number} transfer @property {number} execution
 */

/**
 * @typedef {object} SchedulingDecision The scheduler's verdict for one communication.
 * @property {string} requestId @property {string} qosClass one of {@link QoSClass}
 * @property {string} mode one of {@link SchedulingMode} @property {string} lane
 * @property {string} status one of {@link ScheduleStatus} @property {object|null} window `{ notBefore, notAfter }`
 * @property {number} position queue position (0 = head) @property {boolean} proceed immediate?
 */

/**
 * @typedef {object} OptimizedExecutionPlan The unified plan the optimizer produces.
 * @property {string} planId @property {string} requestId
 * @property {object} executionPlan the frozen Sprint-1 execution plan (ref) @property {SchedulingDecision} schedulingPlan
 * @property {object} qosPlan @property {object} resourceAllocationPlan @property {object} coordinationPlan
 * @property {object} fallbackPlan @property {object[]} timeline ordered `{ stepId, offsetMs, ... }`
 * @property {object} metadata @property {string} createdAt
 */

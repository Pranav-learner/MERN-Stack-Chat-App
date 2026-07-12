/**
 * @module optimization
 *
 * **Layer 12 · Sprint 3 — Resource Optimization & Global Coordination.** An INDEPENDENT subsystem that
 * sits ABOVE the frozen Sprint-1 Communication Fabric + Sprint-2 Adaptive Routing and optimizes the
 * platform GLOBALLY rather than one request at a time. It coordinates communication scheduling, resource
 * allocation, QoS, cross-device coordination, workload balancing, and adaptive execution — WITHOUT
 * modifying any lower communication layer.
 *
 * Pipeline (per request): **collect resources → evaluate QoS (+ adaptive resource policies) → schedule
 * (mode + isolated lane) → allocate resources → coordinate devices → balance workload → build the
 * optimized execution plan (execution + scheduling + QoS + resource + coordination + timeline).** The
 * GLOBAL step is `dispatch()` — draining queued work across lanes by weighted-fair + aging, bounded by the
 * execution budget.
 *
 * @security The optimizer reasons over communication CONTROL-PLANE metadata + ABSTRACT resource budget
 * UNITS only — never plaintext/ciphertext/keys, and never real OS resources (it makes allocation
 * RECOMMENDATIONS, not kernel calls). A no-content deep scan guards every persist.
 *
 * @evolution **Sprint 4 (production hardening / monitoring / observability) consumes this layer's events**
 * and wires a worker/loop around `dispatch()`. Runtime auto-tuning + ML are explicitly out of scope.
 *
 * @example
 * ```js
 * import { GlobalOptimizer, createOptimizationApi, createInMemoryOptimizationRepository } from "./optimization/index.js";
 * const optimizer = new GlobalOptimizer({ ...createInMemoryOptimizationRepository() });
 * const api = createOptimizationApi(optimizer);
 * const r = await api.schedule({ type: "media-transfer", senderId: "alice", recipients: ["bob"], mediaType: "video", payloadRef: { id, size: 50e6 } }, { callerId: "alice" });
 * // r.qos.qosClass, r.scheduling.mode === "batch", r.optimizedPlan.timeline …
 *
 * // …or make the EXISTING Communication Fabric globally optimized:
 * import { createFabricOptimizationIntegration } from "./optimization/index.js";
 * import { CommunicationFabricManager, createInMemoryFabricRepository } from "./_fabric.js";
 * const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository(), ...createFabricOptimizationIntegration({ optimizer }) });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { OptimizationEventBus } from "./events/events.js";

// DTO
export * from "./dto/dto.js";

// Resources
export { GlobalResourceManager } from "./resources/resourceManager.js";
export { estimateCost, addCost } from "./resources/costEstimator.js";
export { DEFAULT_RESOURCE_POLICIES, bandwidthPolicy, memoryPolicy, batteryPolicy, storagePolicy, synchronizationPolicy, communicationPolicy, enterprisePolicy } from "./resources/resourcePolicies.js";

// QoS + scheduler
export { QoSManager } from "./qos/qosManager.js";
export { baseClassFor, laneFor, weightFor, compareClasses, maxClass } from "./qos/qosClasses.js";
export { Lane } from "./scheduler/priorityQueue.js";
export { DEFAULT_SCHEDULING_POLICIES } from "./scheduler/schedulingPolicies.js";
export { CommunicationScheduler } from "./scheduler/scheduler.js";

// Balancing + coordination + planners + execution
export { WorkloadBalancer } from "./balancing/workloadBalancer.js";
export { CrossDeviceCoordinator } from "./coordination/deviceCoordinator.js";
export { buildTimeline } from "./planners/executionTimeline.js";
export { OptimizedExecutionPlanner } from "./planners/executionPlanner.js";
export { ExecutionCoordinator } from "./execution/executionCoordinator.js";

// Validators + serializers
export * from "./validators/validators.js";
export { toResourceView, toQoSView, toSchedulingView, toCoordinationView, toBalanceView, toOptimizedPlanView, toOptimizationView } from "./serializers/serializers.js";

// Repositories
export { createInMemoryOptimizationRepository } from "./repository/inMemoryOptimizationRepository.js";
export { createMongoOptimizationRepository } from "./repository/mongoOptimizationRepository.js";

// Optimizer + API + integration
export { GlobalOptimizer, projectAnalysis } from "./manager/globalOptimizer.js";
export { createOptimizationApi } from "./api/optimizationApi.js";
export { createFabricOptimizationIntegration } from "./integration/fabricIntegration.js";

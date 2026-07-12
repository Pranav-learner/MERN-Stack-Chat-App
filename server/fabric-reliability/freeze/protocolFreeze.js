/**
 * @module fabric-reliability/freeze/protocolFreeze
 *
 * The **Architecture Freeze** manifest (STEP 15) — the authoritative, machine-readable declaration of the
 * Communication Fabric's STABLE public surface at v1.0.0: the public APIs, repositories, events, models,
 * and the pluggable interfaces (decision / policy / strategy / scheduler / registry / scorer / recovery /
 * resilience) future work extends WITHOUT breaking changes. Freezing means: these names + shapes are
 * contracts; extensions register against the documented seams; breaking any entry is a major-version bump.
 *
 * This complements each lower layer's own `*_FINAL.md` freeze; it freezes the LAYER 12 orchestration +
 * reliability surface specifically.
 *
 * @security Pure documentation metadata. No content.
 */

import { deepFreeze } from "../_fabric.js";
import { FABRIC_PROTOCOL_VERSION, ALL_OPERATION_KINDS, ALL_COMPONENT_KINDS, ALL_RELIABILITY_EVENT_TYPES, ALL_METRIC_NAMES } from "../types/types.js";

/** Build the frozen architecture-freeze manifest. */
export function getProtocolFreeze() {
  return deepFreeze({
    protocolVersion: FABRIC_PROTOCOL_VERSION,
    frozenAt: "layer-12-sprint-4",
    status: "frozen",

    // --- stable public APIs (per Layer-12 subsystem) ---
    publicApis: {
      "communication-fabric": ["/api/communication-fabric/execute", "/api/communication-fabric/plan", "/api/communication-fabric/context", "/api/communication-fabric/policies", "/api/communication-fabric/strategy", "/api/communication-fabric/execution-plan", "/api/communication-fabric/diagnostics/:requestId", "/api/communication-fabric/health"],
      "adaptive-routing": ["/api/adaptive-routing/evaluate", "/api/adaptive-routing/best-route", "/api/adaptive-routing/capability-profile", "/api/adaptive-routing/route-scores", "/api/adaptive-routing/explain", "/api/adaptive-routing/fallback-plan", "/api/adaptive-routing/diagnostics/:requestId", "/api/adaptive-routing/health"],
      optimization: ["/api/optimization/schedule", "/api/optimization/execution-plan", "/api/optimization/qos", "/api/optimization/resource-allocation", "/api/optimization/dispatch", "/api/optimization/scheduler-state", "/api/optimization/diagnostics/:requestId", "/api/optimization/status"],
      "fabric-reliability": ["/api/fabric-reliability/health", "/api/fabric-reliability/ready", "/api/fabric-reliability/live", "/api/fabric-reliability/diagnostics", "/api/fabric-reliability/metrics", "/api/fabric-reliability/operations/:operationId", "/api/fabric-reliability/status", "/api/fabric-reliability/freeze"],
    },

    // --- stable repository contracts (storage-independent) ---
    repositories: {
      fabric: ["decisions", "plans", "executions", "audit"],
      adaptive: ["capabilities", "evaluations", "audit"],
      optimization: ["resources", "optimizations", "audit"],
      reliability: ["operations", "health", "audit"],
    },

    // --- stable event buses (Sprint 4 + future monitoring consume these) ---
    events: {
      fabric: 13,
      adaptive: 9,
      optimization: 11,
      reliability: ALL_RELIABILITY_EVENT_TYPES.length,
    },

    // --- stable models (collections) ---
    models: ["FabricDecision", "FabricExecutionPlan", "FabricAuditLog", "AdaptiveCapabilityProfile", "AdaptiveRouteEvaluation", "AdaptiveAuditLog", "OptimizationResourceSnapshot", "OptimizationRecord", "OptimizationAuditLog", "FabricOperation", "FabricHealthSnapshot", "FabricReliabilityAuditLog"],

    // --- documented, stable EXTENSION POINTS (register against these; never fork) ---
    extensionPoints: {
      decisionRules: "communication-fabric: DecisionEngine rules — { id, evaluate(context, draft) }",
      strategies: "communication-fabric: StrategyRegistry.register — { type, supports, baseScore, describe, plan }",
      policies: "communication-fabric: PolicySet.add — { id, kind, applies, evaluate }",
      routePlanner: "communication-fabric: manager.routePlanner dep — { planRoute(decision, context) }",
      scorers: "adaptive-routing: RouteScoringEngine scorers — { dimension, score(candidate, bundle) }",
      policyHooks: "adaptive-routing: policy hooks — { id, kind, evaluate(context, analysis, config) }",
      resourcePolicies: "optimization: QoS/resource hooks — { id, kind, evaluate(ctxBundle) }",
      schedulingPolicies: "optimization: scheduler policies — { id, decide(bundle) }",
      executionHook: "communication-fabric: manager.executionHook dep — ({ context, decision, plan }) => { proceed }",
      subsystemAdapters: "communication-fabric: SubsystemRegistry.register — { kind, actions, execute(step, context) }",
      recoveryStrategies: "fabric-reliability: strategies map — { canResume, resume(checkpoint, executor) }",
      resilience: "fabric-reliability: circuit/retry/timeout/bulkhead config + FailureClassifier rules",
      probes: "fabric-reliability: HealthManager.registerProbe(component, name, fn)",
      metricsExport: "fabric-reliability: FabricMetrics prometheus()/otel() + injected logger + Tracer delegate",
    },

    // --- constants for tooling ---
    operationKinds: ALL_OPERATION_KINDS,
    componentKinds: ALL_COMPONENT_KINDS,
    metricNames: ALL_METRIC_NAMES,

    // --- explicitly out of scope (future major versions) ---
    outOfScope: ["voice-calls", "video-calls", "federation", "multi-cluster-deployment", "machine-learning"],
  });
}

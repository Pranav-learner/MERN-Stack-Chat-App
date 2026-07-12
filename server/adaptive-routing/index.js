/**
 * @module adaptive-routing
 *
 * **Layer 12 · Sprint 2 — Intelligent Routing & Adaptive Communication.** An INDEPENDENT subsystem built ON
 * TOP of the frozen Sprint-1 Communication Fabric that turns its deterministic decision into an ADAPTIVE
 * one. It intelligently decides which transport, which strategy, and which delivery policy to use — direct
 * vs relayed vs offline, whether to synchronize, whether media should stream — WITHOUT hardcoded
 * conditionals, by collecting capability profiles, analyzing the communication + network posture, scoring
 * candidate routes with pluggable scorers, selecting the optimal strategy, and producing explainable
 * execution + fallback plans.
 *
 * Pipeline: **context (Sprint 1) → capabilities → communication analysis → network analysis → policy
 * evaluation → candidate routes → route scoring → strategy selection → fallback planning → execution plan
 * (Sprint 1 planner) → explanation.** Every stage is pluggable; the routing decision emerges from weighted
 * scores + configurable policies + hooks (data-saver / battery-saver / enterprise), never `if` statements.
 *
 * @security The adaptive layer reasons over communication CONTROL-PLANE metadata + declared capability +
 * INJECTED network AVAILABILITY only — never plaintext, ciphertext, or key material. It ranks abstract
 * {@link RouteKind}s; the encrypted bytes still move through the frozen lower layers. A no-content deep
 * scan guards every persist.
 *
 * @evolution **Sprint 3 (resource optimization / QoS / bandwidth management) consumes this layer's events**
 * and activates the reserved zero-weight scoring dimensions (network quality / latency / bandwidth) by
 * supplying a real network provider — no structural change. Runtime probing + ML are explicitly out of
 * scope this sprint.
 *
 * @example
 * ```js
 * import { AdaptiveRoutingEngine, createAdaptiveRoutingApi, createInMemoryAdaptiveRepository } from "./adaptive-routing/index.js";
 * const engine = new AdaptiveRoutingEngine({ ...createInMemoryAdaptiveRepository() });
 * const api = createAdaptiveRoutingApi(engine);
 * const result = await api.evaluate({ type: "direct-message", senderId: "alice", recipients: ["bob"], network: { p2p: false } }, { callerId: "alice" });
 * // result.selection.strategy === "relay"; result.explanation explains why direct lost
 *
 * // …or make the EXISTING Communication Fabric intelligent:
 * import { createFabricAdaptiveIntegration } from "./adaptive-routing/index.js";
 * import { CommunicationFabricManager, createInMemoryFabricRepository } from "./_fabric.js";
 * const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository(), ...createFabricAdaptiveIntegration() });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { AdaptiveEventBus } from "./events/events.js";

// DTO
export * from "./dto/dto.js";

// Capability
export { CapabilityEngine } from "./capability/capabilityEngine.js";
export { createCapabilityProfile, negotiateProfiles, capabilityFingerprint, supportsTransport, hasFeature, supportsMedia, BASELINE_CAPABILITIES } from "./capability/capabilityProfile.js";

// Analyzers
export { CommunicationAnalyzer, classifyPayload } from "./analyzers/communicationAnalyzer.js";
export { NetworkAnalyzer, isUsable } from "./analyzers/networkAnalyzer.js";

// Routing + scoring + selection
export { CandidateBuilder } from "./routing/candidateBuilder.js";
export { createRouteScore, ROUTE_SUBSTRATE } from "./scoring/routeScore.js";
export { DEFAULT_SCORERS, transportAvailabilityScorer, securityScorer, capabilityMatchScorer, policyMatchScorer, costScorer, syncNeedsScorer } from "./scoring/scorers.js";
export { RouteScoringEngine } from "./scoring/routeScoringEngine.js";
export { StrategySelector } from "./selectors/strategySelector.js";

// Policy + fallback + explain + adaptive planner
export { PolicyEvaluationEngine } from "./evaluators/policyEvaluationEngine.js";
export { DEFAULT_POLICY_HOOKS, dataSaverHook, batterySaverHook, enterpriseHook, securityHook } from "./evaluators/policyHooks.js";
export { FallbackPlanner } from "./fallback/fallbackPlanner.js";
export { DecisionExplainer } from "./planners/decisionExplainer.js";
export { AdaptiveRoutePlanner } from "./planners/adaptiveRoutePlanner.js";

// Validators + serializers
export * from "./validators/validators.js";
export { toCapabilityView, toAnalysisView, toNetworkView, toRouteScoreView, toRankingView, toFallbackView, toEvaluationView } from "./serializers/serializers.js";

// Repositories
export { createInMemoryAdaptiveRepository } from "./repository/inMemoryAdaptiveRepository.js";
export { createMongoAdaptiveRepository } from "./repository/mongoAdaptiveRepository.js";

// Engine + API + integration
export { AdaptiveRoutingEngine } from "./manager/adaptiveRoutingEngine.js";
export { createAdaptiveRoutingApi } from "./api/adaptiveRoutingApi.js";
export { createFabricAdaptiveIntegration } from "./integration/fabricIntegration.js";

/**
 * @module communication-fabric
 *
 * **Layer 12 · Sprint 1 — Distributed Communication Fabric (Foundation).** The Fabric is the ORCHESTRATION
 * layer of the entire platform: the single entry point for every communication request. It coordinates
 * the frozen lower layers — security, connectivity, messaging, media, synchronization, groups, delivery —
 * WITHOUT reimplementing any of them. A request flows through a declarative pipeline:
 *
 *   Application → Fabric Manager → Communication Context → Decision Engine → Strategy → Route/Plan →
 *   Orchestration → Subsystem delegation → Execution.
 *
 * Every stage is pluggable through interfaces: strategies (how), decision rules + policies (what's
 * allowed / preferred), routing (where), and a subsystem registry (which lower layer executes). New
 * communication systems — voice, video, a smarter relay — register into the same pipeline without
 * touching the manager, engine, or existing subsystems.
 *
 * @security The Fabric reasons over communication CONTROL-PLANE metadata ONLY — request kind, recipients,
 * conversation/media/priority descriptors, availability, strategy + policy ids, and execution bookkeeping.
 * It NEVER handles plaintext, ciphertext, or key material; a no-content deep scan guards every persist.
 * The bytes always move through the frozen lower layers; the Fabric only decides WHICH run, and in what
 * order.
 *
 * @evolution Sprint 2 (intelligent / adaptive routing, connection scoring, transport optimization,
 * dynamic policy, scheduling) consumes this sprint's events + extends its rule/route/policy seams WITHOUT
 * redesigning the pipeline. Everything deferred to Sprint 2 is declared here as an inert placeholder
 * (RELAY + HYBRID strategies, adaptive routing metadata) so the architecture is already complete.
 *
 * @example
 * ```js
 * import { CommunicationFabricManager, createFabricApi, createInMemoryFabricRepository, createSubsystemAdapter } from "./communication-fabric/index.js";
 * const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository() });
 * fabric.registerSubsystem(createSubsystemAdapter({ kind: "messaging", handler: (step) => sendViaLayer8(step) }));
 * const api = createFabricApi(fabric);
 * const result = await api.execute({ type: "direct-message", senderId: "alice", recipients: ["bob"] }, { callerId: "alice" });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { FabricEventBus } from "./events/events.js";

// DTO + context
export * from "./dto/dto.js";
export { CommunicationContext, deepFreeze } from "./contexts/communicationContext.js";
export { ContextBuilder, buildContext } from "./contexts/contextBuilder.js";

// Decision engine
export { DecisionEngine, hashString } from "./decision-engine/decisionEngine.js";
export { createDecision, deriveConfidence } from "./decision-engine/communicationDecision.js";
export { DEFAULT_DECISION_RULES } from "./decision-engine/decisionRules.js";

// Strategies
export {
  BaseStrategy,
  StrategyRegistry,
  makeStep,
  nextStepId,
  MediaStrategy,
  GroupStrategy,
  SynchronizationStrategy,
  DirectCommunicationStrategy,
  OfflineStrategy,
  RelayStrategy,
  HybridStrategy,
  createDefaultStrategyRegistry,
} from "./strategies/index.js";

// Routing + planners
export { createRoute, fallbacksFor, DEFAULT_FALLBACK_ROUTES, ROUTE_OWNER } from "./routing/route.js";
export { RoutePlanner } from "./routing/routePlanner.js";
export { ExecutionPlanner } from "./planners/executionPlanner.js";

// Policies
export { PolicyKind, PolicySet } from "./policies/policy.js";
export { PolicyEngine } from "./policies/policyEngine.js";
export { DEFAULT_POLICIES } from "./policies/defaultPolicies.js";

// Registry + coordination + orchestration
export { SubsystemRegistry, createSubsystemRegistry } from "./registry/subsystemRegistry.js";
export { createSubsystemAdapter, createRecordingAdapter } from "./registry/subsystemAdapter.js";
export { SubsystemCoordinator } from "./coordinators/subsystemCoordinator.js";
export { Orchestrator } from "./orchestration/orchestrator.js";
export { ExecutionTracker } from "./orchestration/executionTracker.js";

// Validators + serializers
export * from "./validators/validators.js";
export { toDecisionView, toContextView, toPlanView, toExecutionView, toResultView } from "./serializers/serializers.js";

// Repositories
export { createInMemoryFabricRepository } from "./repository/inMemoryFabricRepository.js";
export { createMongoFabricRepository } from "./repository/mongoFabricRepository.js";

// Cache + manager + API
export { DecisionCache } from "./manager/decisionCache.js";
export { CommunicationFabricManager } from "./manager/communicationFabricManager.js";
export { createFabricApi } from "./api/fabricApi.js";

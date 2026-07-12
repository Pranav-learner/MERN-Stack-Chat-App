/**
 * @module adaptive-routing/_fabric
 *
 * Internal re-export of the frozen Sprint-1 Communication Fabric symbols this layer consumes, imported
 * from their SPECIFIC source files rather than the fabric's index barrel. The barrel additionally pulls in
 * the Mongo-backed repository (→ `mongoose`), which is only needed by production wiring; importing the
 * specific files keeps the whole adaptive layer — and its DB-free test suite — free of that dependency,
 * exactly as the Sprint-1 tests are. This is a pure re-export; it adds no behaviour.
 */

export {
  CommunicationType,
  ConversationType,
  MediaType,
  Priority,
  StrategyType,
  RouteKind,
  SubsystemKind,
  PRIORITY_RANK,
  ALL_SUBSYSTEM_KINDS,
  FabricEventType,
  DecisionConfidence,
} from "../communication-fabric/types/types.js";
export { deepFreeze, CommunicationContext } from "../communication-fabric/contexts/communicationContext.js";
export { ContextBuilder, buildContext } from "../communication-fabric/contexts/contextBuilder.js";
export { normalizeCommunicationRequest } from "../communication-fabric/dto/dto.js";
export { createDefaultStrategyRegistry, StrategyRegistry } from "../communication-fabric/strategies/index.js";
export { ExecutionPlanner } from "../communication-fabric/planners/executionPlanner.js";
export { createDecision } from "../communication-fabric/decision-engine/communicationDecision.js";
export { createRoute, fallbacksFor } from "../communication-fabric/routing/route.js";
export { validateRequest, validateContext, assertNoContent } from "../communication-fabric/validators/validators.js";
export { PolicyEngine } from "../communication-fabric/policies/policyEngine.js";
export { PolicyKind } from "../communication-fabric/policies/policy.js";
export { PolicyDeniedError } from "../communication-fabric/errors.js";
export { DecisionCache } from "../communication-fabric/manager/decisionCache.js";
export { FabricEventBus } from "../communication-fabric/events/events.js";
export { CommunicationFabricManager } from "../communication-fabric/manager/communicationFabricManager.js";
export { createInMemoryFabricRepository } from "../communication-fabric/repository/inMemoryFabricRepository.js";
export { createSubsystemAdapter, createRecordingAdapter } from "../communication-fabric/registry/subsystemAdapter.js";

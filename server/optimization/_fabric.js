/**
 * @module optimization/_fabric
 *
 * Internal re-export of the frozen Sprint-1 Communication Fabric symbols this layer consumes, imported
 * from their SPECIFIC source files rather than the fabric's index barrel. The barrel additionally pulls in
 * the Mongo-backed repository (→ `mongoose`), which is only needed by production wiring; importing the
 * specific files keeps the whole optimization layer — and its DB-free test suite — free of that
 * dependency, exactly as the Sprint-1 + Sprint-2 tests are. Pure re-export; adds no behaviour.
 */

export { CommunicationType, ConversationType, MediaType, Priority, StrategyType, RouteKind, SubsystemKind, PRIORITY_RANK } from "../communication-fabric/types/types.js";
export { deepFreeze, CommunicationContext } from "../communication-fabric/contexts/communicationContext.js";
export { ContextBuilder, buildContext } from "../communication-fabric/contexts/contextBuilder.js";
export { normalizeCommunicationRequest } from "../communication-fabric/dto/dto.js";
export { validateRequest, validateContext, assertNoContent } from "../communication-fabric/validators/validators.js";
export { CommunicationFabricManager } from "../communication-fabric/manager/communicationFabricManager.js";
export { createInMemoryFabricRepository } from "../communication-fabric/repository/inMemoryFabricRepository.js";

/**
 * @module pdp
 *
 * Public entry point of the **Peer Discovery Protocol (PDP)** — Layer 6, Sprint 4. PDP is the
 * ORCHESTRATION layer that unifies the three Sprint 1–3 subsystems (Discovery, Presence, Capability
 * Exchange) into one deterministic workflow producing a validated {@link ConnectionPlan}:
 *
 * ```
 * Discovery (who + which devices) → Presence (which are reachable) → Capabilities (how they talk)
 *                                        ↓ selection ↓
 *                                    Connection Plan   →   (FUTURE Layer 7 establishes the connection)
 * ```
 *
 * ## Out of scope for Sprint 4 (Layer 7)
 * NO NAT Traversal, NO ICE/STUN/TURN, NO WebRTC, NO direct P2P, NO socket creation, NO hole
 * punching, NO connection establishment. PDP produces a transport-independent PLAN only. The plan's
 * `connection` + `nat` blocks are inert placeholders Layer 7 fills.
 *
 * @security Everything here is PUBLIC control-plane metadata. PDP NEVER touches a private key,
 * session key, message key, chain key, or shared secret; the {@link module:pdp/validators} no-secret
 * invariant is enforced before a plan is stored or returned.
 *
 * @example Wiring (compose the three subsystem managers + a PDP repo)
 * ```js
 * import { PeerDiscoveryManager, createInMemoryPdpRepository, createPdpApi } from "./peer-discovery-protocol/index.js";
 * const pdp = new PeerDiscoveryManager({ discovery, presence, capabilities, ...createInMemoryPdpRepository() });
 * const api = createPdpApi(pdp);
 * const { plan } = await api.startDiscovery({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2" });
 * ```
 */

// Manager + API facade
export { PeerDiscoveryManager } from "./manager/peerDiscoveryManager.js";
export { createPdpApi } from "./api/pdpApi.js";

// Protocol definition
export { PROTOCOL_DEFINITION, isRecoverableFailure } from "./protocol/protocol.js";

// Workflow engine + lifecycle + session model
export { runDiscoveryWorkflow } from "./workflow/workflow.js";
export {
  PdpLifecycle,
  ALLOWED_PDP_TRANSITIONS,
  canPdpTransition,
  assertPdpTransition,
  nextPdpStates,
} from "./workflow/lifecycle.js";
export {
  createPdpSession,
  isPdpSessionExpired,
  isPdpSessionTerminal,
  pdpDedupeKey,
} from "./workflow/session.js";

// Planner (connection plan)
export {
  createConnectionPlan,
  isPlanExpired,
  planCacheKey,
  createConnectionPlaceholder,
  createNatPlaceholder,
} from "./planner/connectionPlan.js";

// Selectors
export { selectDevices, scoreFor, capabilityScore, resolveSelectionPolicy } from "./selectors/selection.js";

// Negotiation orchestration
export { negotiateCandidates } from "./negotiation/negotiation.js";

// Cache
export { ConnectionPlanCache, PlanCacheOutcome } from "./cache/cache.js";

// Repositories
export { createInMemoryPdpRepository } from "./repositories/inMemoryPdpRepository.js";
export { createMongoPdpRepository } from "./repositories/mongoPdpRepository.js";

// Events
export { PdpEventBus } from "./events/events.js";

// Validation
export {
  validateDiscoveryId,
  validatePlanId,
  validateUserRef,
  validateDeviceRef,
  validateSelectionPolicy,
  validateStartRequest,
  requirePdpSession,
  requirePlan,
  assertSessionNotExpired,
  assertPlanNotExpired,
  assertRequester,
  assertNoSecretMaterial,
  validateConnectionPlan,
  validatePdpSession,
  validateSessionRepository,
  validatePlanRepository,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Serialization
export {
  toPublicPlan,
  toPublicSession,
  toPublicSelectedDevice,
  toPdpStatus,
  toSessionListItem,
} from "./serializers/serializer.js";

// Errors + types
export * from "./errors.js";
export {
  PdpState,
  ALL_PDP_STATES,
  ACTIVE_PDP_STATES,
  TERMINAL_PDP_STATES,
  isTerminalPdpState,
  isActivePdpState,
  WorkflowStage,
  WORKFLOW_STAGE_ORDER,
  SelectionPolicy,
  ALL_SELECTION_POLICIES,
  PdpEventType,
  PdpFailureReason,
  PdpSource,
  PDP_SCHEMA_VERSION,
  PDP_PROTOCOL,
  PDP_PROTOCOL_VERSION,
  DEFAULT_PDP_SESSION_TTL_MS,
  DEFAULT_PLAN_TTL_MS,
  DEFAULT_PLAN_CACHE_TTL_MS,
  DEFAULT_PLAN_CACHE_LIMIT,
  DEFAULT_MAX_SELECTED_DEVICES,
} from "./types/types.js";

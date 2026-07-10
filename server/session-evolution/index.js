/**
 * @module session-evolution
 *
 * Public entry point of the **Session Evolution Framework** — Layer 5, Sprint 1. Builds
 * the reusable ARCHITECTURE that lets cryptographic sessions evolve over time:
 * generations, an evolution lifecycle, policies, a scheduler, versioned history, a
 * metadata framework, validation, repositories, events, and application integration.
 *
 * ## Out of scope for Sprint 1 (future Layer 5 sprints)
 * NO Forward Secrecy, NO Automatic Rekeying, NO Chain Keys, NO Message Keys, NO Double
 * Ratchet, NO Post-Compromise Security, NO P2P/WebRTC. This sprint performs **NO
 * cryptography** — it never derives, rotates, or ratchets a key. It only makes the
 * application AWARE that Secure Sessions have generations and records WHEN evolution
 * should occur. Future sprints plug their key mechanics INTO this framework.
 *
 * @example Device / test wiring (zero deps)
 * ```js
 * import { EvolutionManager, createInMemoryEvolutionRepository, createTimeBasedPolicy } from "./session-evolution/index.js";
 * const evo = new EvolutionManager({ ...createInMemoryEvolutionRepository() });
 * const rec = await evo.createEvolutionState({ sessionId, handshakeId });
 * await evo.attachPolicy(sessionId, createTimeBasedPolicy({ intervalMs: 86_400_000 }));
 * ```
 *
 * @example Server wiring (Mongo, evolution-aware sessions)
 * ```js
 * import { EvolutionManager, createMongoEvolutionRepository, attachSessionEvolution } from "./session-evolution/index.js";
 * const evo = new EvolutionManager({ ...createMongoEvolutionRepository() });
 * attachSessionEvolution({ sessionEvents: secureSessionEvents, evolutionManager: evo });
 * ```
 */

// Manager + repositories
export { EvolutionManager } from "./manager/evolutionManager.js";
export { createInMemoryEvolutionRepository } from "./repository/inMemoryEvolutionRepository.js";
export { createMongoEvolutionRepository } from "./repository/mongoEvolutionRepository.js";

// Scheduler + events
export { EvolutionScheduler } from "./schedulers/scheduler.js";
export { EvolutionEventBus } from "./events/events.js";

// State model
export {
  createEvolutionRecord,
  isEvolutionRetired,
  hasPendingEvolution,
  projectNextGeneration,
} from "./state/evolutionState.js";

// Lifecycle
export {
  EvolutionLifecycle,
  ALLOWED_EVOLUTION_TRANSITIONS,
  canEvolutionTransition,
  assertEvolutionTransition,
  nextEvolutionStates,
} from "./lifecycle/lifecycle.js";

// Generations / versioning
export {
  isValidGeneration,
  assertMonotonicAdvance,
  assertNoDuplicateGeneration,
  buildVersionEntry,
  currentGeneration,
  previousGeneration,
  futureGeneration,
  migrationSnapshot,
  rollbackMetadata,
} from "./evolution/generations.js";

// Policies
export {
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createManualPolicy,
  createSecurityEventPolicy,
  createDeviceEventPolicy,
  createAdministratorPolicy,
  createCustomPolicy,
  evaluatePolicy,
  evaluatePolicies,
  isPolicyDescriptor,
  serializePolicy,
  POLICY_EVALUATORS,
} from "./policies/policies.js";

// Metadata framework
export {
  createEvolutionMetadata,
  createPolicyMetadata,
  createSecurityMetadata,
  createAuditEntry,
  appendAudit,
  createRatchetMetadata,
  createChainMetadata,
  createMessageMetadata,
  recomputeMetadata,
} from "./metadata/metadata.js";

// Validation
export {
  validateEvolutionId,
  validateSessionRef,
  requireEvolution,
  assertNoDuplicateEvolution,
  assertNotRetired,
  validateGeneration,
  validateEvolutionMetadata,
  validatePolicyDescriptor,
  assertNoPolicyConflict,
  validateEvolutionRequest,
  validateRepository,
} from "./validators/validators.js";

// Serialization
export { toPublicEvolution, toEvolutionStatus, toEvolutionMetadata } from "./serialization/serializer.js";

// Application integration
export { attachSessionEvolution, deriveGenerationView } from "./integration/sessionEvolutionBridge.js";

// Errors + types
export * from "./errors.js";
export {
  EvolutionState,
  ALL_EVOLUTION_STATES,
  ACTIVE_EVOLUTION_STATES,
  PENDING_EVOLUTION_STATES,
  TERMINAL_EVOLUTION_STATES,
  isTerminalEvolutionState,
  isActiveEvolutionState,
  isPendingEvolutionState,
  PolicyType,
  ALL_POLICY_TYPES,
  EvolutionTrigger,
  EvolutionEventType,
  EvolutionFailureReason,
  EVOLUTION_SCHEMA_VERSION,
  EVOLUTION_FRAMEWORK,
  INITIAL_GENERATION,
} from "./types/types.js";

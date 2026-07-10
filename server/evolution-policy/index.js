/**
 * @module evolution-policy
 *
 * Public entry point of the **Automatic Rekeying & Evolution Policy** engine — Layer 5,
 * Sprint 3. Secure sessions now evolve *automatically* according to configurable policies:
 * the application no longer depends on manual key evolution.
 *
 * ## What this sprint adds
 * - a **policy engine** that binds + deterministically evaluates policies per session;
 * - an **automatic rekey manager** that triggers evolution, queues + deduplicates
 *   operations, and coordinates with the Sprint 2 forward-secrecy engine;
 * - a full **execution state machine** (pending → executing → completed / failed, with
 *   retry, cancellation, and generation-based conflict resolution);
 * - autonomous **scheduling** + reactive **triggers** (time / message-count / device /
 *   security / session-age);
 * - transparent **Secure Transport integration**, repositories, audit, and events.
 *
 * ## Out of scope (later sprints)
 * NO Chain Keys, NO Message Keys, NO Double Ratchet, NO Post-Compromise Security. This
 * sprint automates *session-generation* evolution; the crypto itself is the Sprint 2 engine.
 *
 * @example Device wiring
 * ```js
 * import { AutomaticRekeyManager, createInMemoryPolicyRepository, createMessageCountPolicy } from "./evolution-policy/index.js";
 * const rekey = new AutomaticRekeyManager({ ...createInMemoryPolicyRepository(), forwardSecrecy });
 * await rekey.configure({ sessionId, handshakeId, policies: [createMessageCountPolicy({ maxMessages: 100 })] });
 * await rekey.recordMessage(sessionId); // transparently rekeys at the threshold
 * ```
 */

// Manager + engines + repositories
export { AutomaticRekeyManager } from "./manager/automaticRekeyManager.js";
export { RekeyExecutionEngine } from "./execution/executionEngine.js";
export { RekeyScheduler } from "./scheduler/rekeyScheduler.js";
export { createInMemoryPolicyRepository } from "./repository/inMemoryPolicyRepository.js";
export { createMongoPolicyRepository } from "./repository/mongoPolicyRepository.js";

// Policies + evaluation + triggers
export {
  createManualPolicy,
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createSecurityEventPolicy,
  createDeviceEventPolicy,
  createAdministratorPolicy,
  createCustomPolicy,
  createSessionAgePolicy,
  serializePolicy,
  isPolicyDescriptor,
} from "./policies/policyFactory.js";
export { evaluatePolicy, evaluatePolicies } from "./evaluator/policyEvaluator.js";
export { MessageCounter, buildEvaluationContext } from "./triggers/triggers.js";

// Transport integration
export {
  encryptWithAutoRekey,
  decryptWithAutoRekey,
  resolveActiveGeneration,
  createAutoRekeyInterceptor,
} from "./transport/transportIntegration.js";

// Metadata + audit + events + serialization + validators
export { createPolicyMetadata, createExecutionMetadata, createSecurityMetadata, recomputeMetadata } from "./metadata/metadata.js";
export { auditEntry, appendAudit, assertNoSecretMaterial, AuditAction } from "./audit/audit.js";
export { RekeyEventBus, RekeyEventType } from "./events/events.js";
export { toPublicRekeyState, toRekeyStatus, toPublicExecution } from "./serialization/serializer.js";
export {
  validateSessionRef,
  requireState,
  validatePolicyDescriptor,
  assertNoPolicyConflict,
  assertNoDuplicateExecution,
  assertGenerationMatch,
  validateSchedule,
  assertSessionNotExpired,
  validateRekeyRequest,
  validateRepository,
} from "./validators/validators.js";

// Errors + types
export * from "./errors.js";
export {
  PolicyType,
  ALL_POLICY_TYPES,
  SINGLETON_POLICY_TYPES,
  TriggerType,
  ExecutionState,
  ALL_EXECUTION_STATES,
  TERMINAL_EXECUTION_STATES,
  isTerminalExecutionState,
  isActiveExecutionState,
  RekeyEventType as RekeyEventTypes,
  RekeyFailureReason,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  REKEY_SCHEMA_VERSION,
} from "./types/types.js";

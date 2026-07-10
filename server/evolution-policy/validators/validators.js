/**
 * @module evolution-policy/validators
 *
 * Validation for the automatic-rekey engine. Covers every spec item: duplicate execution,
 * policy conflicts, generation mismatch, concurrent evolution, invalid schedules, expired
 * sessions, replay attempts, and malformed requests.
 *
 * @security Also enforces that a rekey request never smuggles key material (the crypto is
 * the Sprint 2 engine's job).
 */

import {
  RekeyValidationError,
  RekeyNotConfiguredError,
  PolicyConflictError,
  DuplicateExecutionError,
  GenerationMismatchError,
  InvalidScheduleError,
  SessionExpiredError,
} from "../errors.js";
import { ALL_POLICY_TYPES, SINGLETON_POLICY_TYPES, isActiveExecutionState } from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate a session-id reference. @throws {RekeyValidationError} */
export function validateSessionRef(sessionId) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) {
    throw new RekeyValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Require a configured policy-state record. @throws {RekeyNotConfiguredError} */
export function requireState(state, sessionId) {
  if (!state) throw new RekeyNotConfiguredError("Automatic rekeying is not configured for this session", { details: { sessionId } });
  return state;
}

/** Validate a policy descriptor's shape. @throws {RekeyValidationError} */
export function validatePolicyDescriptor(policy) {
  if (!policy || typeof policy !== "object" || typeof policy.id !== "string" || !ALL_POLICY_TYPES.includes(policy.type)) {
    throw new RekeyValidationError("Malformed policy descriptor", { details: { type: policy?.type } });
  }
  return policy;
}

/**
 * Assert a new policy does not conflict with the existing set (duplicate id, or a second
 * singleton-type policy). @throws {PolicyConflictError}
 */
export function assertNoPolicyConflict(existing, candidate) {
  const list = existing ?? [];
  if (list.some((p) => p.id === candidate.id)) {
    throw new PolicyConflictError(`A policy with id "${candidate.id}" is already attached`, { details: { id: candidate.id } });
  }
  if (SINGLETON_POLICY_TYPES.includes(candidate.type) && list.some((p) => p.type === candidate.type)) {
    throw new PolicyConflictError(`A "${candidate.type}" policy is already attached (only one allowed)`, { details: { type: candidate.type } });
  }
  return candidate;
}

/**
 * Assert no active (pending/executing) execution already occupies the session slot.
 * @param {object|null} pending @throws {DuplicateExecutionError}
 */
export function assertNoDuplicateExecution(pending) {
  if (pending && isActiveExecutionState(pending.state)) {
    throw new DuplicateExecutionError("A rekey execution is already active for this session", {
      details: { executionId: pending.executionId, state: pending.state },
    });
  }
}

/**
 * Assert the generation observed at trigger time still matches the current generation.
 * @param {number} expected @param {number} current @throws {GenerationMismatchError}
 */
export function assertGenerationMatch(expected, current) {
  if (expected != null && expected !== current) {
    throw new GenerationMismatchError("Generation mismatch — the session already evolved", { details: { expected, current } });
  }
}

/** Validate a schedule spec (positive interval / due). @throws {InvalidScheduleError} */
export function validateSchedule(spec) {
  if (!spec || typeof spec !== "object") throw new InvalidScheduleError("Malformed schedule");
  if (spec.intervalMs !== undefined && (!Number.isFinite(spec.intervalMs) || spec.intervalMs <= 0)) {
    throw new InvalidScheduleError("Schedule intervalMs must be positive", { details: { intervalMs: spec.intervalMs } });
  }
  if (spec.dueInMs !== undefined && (!Number.isFinite(spec.dueInMs) || spec.dueInMs <= 0)) {
    throw new InvalidScheduleError("Schedule dueInMs must be positive", { details: { dueInMs: spec.dueInMs } });
  }
  return spec;
}

/**
 * Assert a session is not expired / is in a state that permits evolution.
 * @param {string} [sessionStatus] @throws {SessionExpiredError}
 */
export function assertSessionNotExpired(sessionStatus) {
  if (sessionStatus === undefined || sessionStatus === null) return; // opt-in
  if (["expired", "closed", "destroyed", "failed", "invalid"].includes(sessionStatus)) {
    throw new SessionExpiredError(`Cannot rekey a session in state "${sessionStatus}"`, { details: { sessionStatus } });
  }
}

/**
 * Validate a raw rekey request payload (guards against malformed requests + key material).
 * @param {object} request @throws {RekeyValidationError}
 */
export function validateRekeyRequest(request) {
  if (!request || typeof request !== "object") throw new RekeyValidationError("Malformed rekey request");
  validateSessionRef(request.sessionId);
  if (request.reason !== undefined && typeof request.reason !== "string") {
    throw new RekeyValidationError("Rekey reason must be a string");
  }
  for (const forbidden of ["keys", "chainSecret", "sharedSecret", "encryptionKey", "rootSecret"]) {
    if (forbidden in request) throw new RekeyValidationError(`Rekey request must not contain "${forbidden}"`, { details: { field: forbidden } });
  }
  return request;
}

/** Validate a repository implements the required contract. @throws {RekeyValidationError} */
export function validateRepository(repo, methods = ["create", "findBySessionId", "update", "delete", "listAll"]) {
  if (!repo || typeof repo !== "object") throw new RekeyValidationError("Rekey repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new RekeyValidationError(`Rekey repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}

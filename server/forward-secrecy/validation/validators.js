/**
 * @module forward-secrecy/validation
 *
 * Validation for the Forward Secrecy Engine. Covers every spec item: generation
 * ordering, evolution requests, session ownership, session state, version consistency,
 * destroyed-key references, replay attempts, and malformed evolution payloads.
 * Generation forward-only ordering lives in {@link module:forward-secrecy/lifecycle};
 * this module covers the rest and re-exports the ordering guards for convenience.
 */

import {
  ForwardSecrecyValidationError,
  GenerationNotFoundError,
  SessionOwnershipError,
  ReplayDetectedError,
  DestroyedKeyReferenceError,
  ForwardSecrecyStateError,
} from "../errors.js";
import { assertForwardOnly } from "../lifecycle/generationLifecycle.js";
import { GenerationStatus } from "../types/types.js";

// Same id shape as sessions/evolution so everything lines up.
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate a session-id reference. @throws {ForwardSecrecyValidationError} */
export function validateSessionRef(sessionId) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) {
    throw new ForwardSecrecyValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Require a forward-secrecy state record. @throws {GenerationNotFoundError} */
export function requireState(state, sessionId) {
  if (!state) throw new GenerationNotFoundError("Forward secrecy state not found", { details: { sessionId } });
  return state;
}

/**
 * Validate a raw evolution request payload (guards against malformed payloads before the
 * manager derives anything).
 * @param {object} request @throws {ForwardSecrecyValidationError}
 */
export function validateEvolutionRequest(request) {
  if (!request || typeof request !== "object") {
    throw new ForwardSecrecyValidationError("Malformed evolution request", {});
  }
  validateSessionRef(request.sessionId);
  if (request.reason !== undefined && typeof request.reason !== "string") {
    throw new ForwardSecrecyValidationError("Evolution reason must be a string", {});
  }
  if (request.trigger !== undefined && typeof request.trigger !== "string") {
    throw new ForwardSecrecyValidationError("Evolution trigger must be a string", {});
  }
  // A request must NEVER carry key material.
  for (const forbidden of ["chainSecret", "keys", "encryptionKey", "macKey", "sharedSecret", "rootSecret"]) {
    if (forbidden in request) {
      throw new ForwardSecrecyValidationError(`Evolution request must not contain "${forbidden}"`, { details: { field: forbidden } });
    }
  }
  return request;
}

/**
 * Assert generation ordering for an advance (forward-only, +1). Delegates to the
 * lifecycle guard.
 * @param {number} current @param {number} next
 */
export function assertGenerationOrdering(current, next) {
  assertForwardOnly(current, next);
}

/**
 * Assert the caller owns/participates in the session.
 * @param {string[]} owners participant/owner ids @param {string} [actingUser]
 * @throws {SessionOwnershipError}
 */
export function assertSessionOwnership(owners, actingUser) {
  if (actingUser === undefined || actingUser === null) return; // ownership check is opt-in
  if (!(owners ?? []).map(String).includes(String(actingUser))) {
    throw new SessionOwnershipError("Caller is not an owner of this session", { details: { actingUser } });
  }
}

/**
 * Assert a session is in a state where evolution is permitted (active-family).
 * @param {string} [sessionStatus] the Secure Session status, if known
 * @throws {ForwardSecrecyStateError}
 */
export function assertSessionState(sessionStatus) {
  if (sessionStatus === undefined || sessionStatus === null) return; // opt-in when a session status is supplied
  const OK = ["active", "idle", "paused", "resumed", "created"];
  if (!OK.includes(sessionStatus)) {
    throw new ForwardSecrecyStateError(`Cannot evolve a session in state "${sessionStatus}"`, { details: { sessionStatus } });
  }
}

/**
 * Assert the store's current generation matches the metadata record's (version
 * consistency between the device key store and the repository).
 * @param {number} storeGeneration @param {number} recordGeneration @throws {ForwardSecrecyStateError}
 */
export function assertVersionConsistency(storeGeneration, recordGeneration) {
  if (storeGeneration !== recordGeneration) {
    throw new ForwardSecrecyStateError("Key store and metadata generation are inconsistent", {
      details: { storeGeneration, recordGeneration },
    });
  }
}

/**
 * Assert a referenced generation's keys still exist (not already destroyed).
 * @param {object|null} keys @param {number} generation @throws {DestroyedKeyReferenceError}
 */
export function assertNotDestroyed(keys, generation) {
  if (!keys) {
    throw new DestroyedKeyReferenceError(`Generation ${generation} key material has been destroyed`, { details: { generation } });
  }
  return keys;
}

/**
 * Assert an evolution does not replay an already-recorded generation.
 * @param {import("../types/types.js").GenerationRecord[]} generations @param {number} nextGeneration
 * @throws {ReplayDetectedError}
 */
export function assertNoReplay(generations, nextGeneration) {
  if ((generations ?? []).some((g) => g.generation === nextGeneration)) {
    throw new ReplayDetectedError(`Generation ${nextGeneration} already exists — replay refused`, { details: { generation: nextGeneration } });
  }
}

/**
 * Validate a repository implements the required contract.
 * @param {object} repo @param {string[]} [methods] @throws {ForwardSecrecyValidationError}
 */
export function validateRepository(repo, methods = ["create", "findBySessionId", "update", "delete", "listAll"]) {
  if (!repo || typeof repo !== "object") {
    throw new ForwardSecrecyValidationError("Forward secrecy repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new ForwardSecrecyValidationError(`Forward secrecy repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

export { assertForwardOnly, GenerationStatus };

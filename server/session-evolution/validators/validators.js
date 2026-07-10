/**
 * @module session-evolution/validators
 *
 * Validation for the Session Evolution Framework. Covers every spec item: invalid
 * generations, duplicate generations, corrupted metadata, unknown sessions, expired
 * sessions, policy conflicts, invalid transitions, and malformed evolution requests.
 * State-transition validation itself lives in {@link module:session-evolution/lifecycle};
 * this module covers the rest.
 *
 * @security Also enforces the framework's core invariant: an evolution record must
 * NEVER carry raw key material (no key bytes, no shared secret, no ratchet secret).
 */

import { ALL_EVOLUTION_STATES, ALL_POLICY_TYPES, EvolutionState } from "../types/types.js";
import {
  EvolutionValidationError,
  EvolutionNotFoundError,
  DuplicateEvolutionError,
  CorruptedEvolutionMetadataError,
  PolicyConflictError,
  EvolutionRetiredError,
} from "../errors.js";
import { isValidGeneration } from "../evolution/generations.js";
import { isPolicyDescriptor } from "../policies/policies.js";

// Same id shape as Secure Session ids so evolution records line up with sessions.
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate an evolution id's shape. @throws {EvolutionValidationError} */
export function validateEvolutionId(evolutionId) {
  if (typeof evolutionId !== "string" || !ID_RE.test(evolutionId)) {
    throw new EvolutionValidationError("Invalid evolution identifier", { details: { evolutionId } });
  }
  return evolutionId;
}

/** Validate a session-id reference. @throws {EvolutionValidationError} */
export function validateSessionRef(sessionId) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) {
    throw new EvolutionValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Require an evolution record to exist. @throws {EvolutionNotFoundError} */
export function requireEvolution(record, ref) {
  if (!record) throw new EvolutionNotFoundError("Evolution state not found", { details: { ref } });
  return record;
}

/** Assert there is no existing evolution record for a session. @throws {DuplicateEvolutionError} */
export function assertNoDuplicateEvolution(existing) {
  if (existing) {
    throw new DuplicateEvolutionError("An evolution state already exists for this session", {
      details: { sessionId: existing.sessionId, evolutionId: existing.evolutionId },
    });
  }
}

/** Assert a record is not retired (terminal). @throws {EvolutionRetiredError} */
export function assertNotRetired(record) {
  if (record?.state === EvolutionState.RETIRED) {
    throw new EvolutionRetiredError("Evolution tracking has been retired for this session", {
      details: { sessionId: record.sessionId },
    });
  }
}

/** Validate a generation number. @throws {EvolutionValidationError} */
export function validateGeneration(generation) {
  if (!isValidGeneration(generation)) {
    throw new EvolutionValidationError("Generation must be a non-negative integer", { details: { generation } });
  }
  return generation;
}

/**
 * Validate an evolution record's stored metadata shape (detects corruption/tampering
 * and forbidden key material).
 * @param {object} record @throws {CorruptedEvolutionMetadataError}
 */
export function validateEvolutionMetadata(record) {
  if (!record || typeof record !== "object") {
    throw new CorruptedEvolutionMetadataError("Evolution record is not an object");
  }
  for (const field of ["evolutionId", "sessionId", "state", "generation", "keyVersion"]) {
    if (record[field] === undefined || record[field] === null) {
      throw new CorruptedEvolutionMetadataError(`Evolution record is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_EVOLUTION_STATES.includes(record.state)) {
    throw new CorruptedEvolutionMetadataError(`Unknown evolution state: ${record.state}`, { details: { state: record.state } });
  }
  if (!isValidGeneration(record.generation)) {
    throw new CorruptedEvolutionMetadataError("Evolution generation is malformed", { details: { generation: record.generation } });
  }
  if (typeof record.keyVersion !== "object" || !isValidGeneration(record.keyVersion.current)) {
    throw new CorruptedEvolutionMetadataError("Evolution key-version pointer is malformed");
  }
  if (!Array.isArray(record.versionHistory)) {
    throw new CorruptedEvolutionMetadataError("Evolution version history is malformed");
  }
  // Core invariant: an evolution record must NEVER carry raw key material.
  if (containsKeyMaterial(record)) {
    throw new CorruptedEvolutionMetadataError("Evolution record must not contain raw key material");
  }
  // Duplicate generations in the timeline are corruption.
  const seen = new Set();
  for (const h of record.versionHistory) {
    if (seen.has(h.generation)) {
      throw new CorruptedEvolutionMetadataError(`Duplicate generation ${h.generation} in version history`, { details: { generation: h.generation } });
    }
    seen.add(h.generation);
  }
  return record;
}

/** Whether an object graph carries anything that looks like secret key material. */
function containsKeyMaterial(record) {
  const forbidden = ["sharedSecret", "privateKey", "rootKey", "chainKey", "messageKey", "keyBytes"];
  if (forbidden.some((k) => k in record)) return true;
  if (record.keyVersion?.bytes !== undefined) return true;
  for (const block of [record.ratchetMetadata, record.chainMetadata, record.messageMetadata]) {
    if (block && (block.bytes !== undefined || block.secret !== undefined || block.key !== undefined)) return true;
  }
  return false;
}

/**
 * Validate a policy descriptor's shape.
 * @param {object} policy @throws {EvolutionValidationError}
 */
export function validatePolicyDescriptor(policy) {
  if (!isPolicyDescriptor(policy)) {
    throw new EvolutionValidationError("Malformed policy descriptor", { details: { policy: policy?.type } });
  }
  if (!ALL_POLICY_TYPES.includes(policy.type)) {
    throw new EvolutionValidationError(`Unknown policy type "${policy.type}"`, { details: { type: policy.type } });
  }
  return policy;
}

/**
 * Assert a new policy does not conflict with the existing set. A conflict is a duplicate
 * policy id, or a second policy of a mutually-exclusive type (MANUAL / ADMINISTRATOR are
 * singletons — attaching two makes intent ambiguous).
 * @param {import("../types/types.js").PolicyDescriptor[]} existing @param {import("../types/types.js").PolicyDescriptor} candidate
 * @throws {PolicyConflictError}
 */
export function assertNoPolicyConflict(existing, candidate) {
  const list = existing ?? [];
  if (list.some((p) => p.id === candidate.id)) {
    throw new PolicyConflictError(`A policy with id "${candidate.id}" is already attached`, { details: { id: candidate.id } });
  }
  const SINGLETON_TYPES = ["manual", "administrator"];
  if (SINGLETON_TYPES.includes(candidate.type) && list.some((p) => p.type === candidate.type)) {
    throw new PolicyConflictError(`A "${candidate.type}" policy is already attached (only one allowed)`, { details: { type: candidate.type } });
  }
  return candidate;
}

/**
 * Validate a raw evolution request payload (e.g. from an API / message). Guards against
 * malformed evolution requests before they reach the manager.
 * @param {object} request @param {{ requireSessionId?: boolean }} [options]
 * @throws {EvolutionValidationError}
 */
export function validateEvolutionRequest(request, options = {}) {
  if (!request || typeof request !== "object") {
    throw new EvolutionValidationError("Malformed evolution request", {});
  }
  if (options.requireSessionId !== false) validateSessionRef(request.sessionId);
  if (request.reason !== undefined && typeof request.reason !== "string") {
    throw new EvolutionValidationError("Evolution request reason must be a string", {});
  }
  if (request.policies !== undefined) {
    if (!Array.isArray(request.policies)) throw new EvolutionValidationError("Evolution request policies must be an array", {});
    request.policies.forEach(validatePolicyDescriptor);
  }
  return request;
}

/**
 * Validate a repository implements the required contract.
 * @param {object} repo @param {string[]} [methods] @throws {EvolutionValidationError}
 */
export function validateRepository(
  repo,
  methods = ["create", "findBySessionId", "findById", "update", "delete", "findByState", "listAll"],
) {
  if (!repo || typeof repo !== "object") {
    throw new EvolutionValidationError("Evolution repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new EvolutionValidationError(`Evolution repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

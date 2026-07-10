/**
 * @module key-hierarchy/validators
 *
 * Validation for the key hierarchy. Covers every spec item: invalid root keys, chain
 * mismatch, generation mismatch, corrupted metadata, missing chain, duplicate chain, chain
 * rollback, and malformed chain state.
 *
 * @security Also enforces the invariant that a hierarchy record never carries raw key
 * material (no root/chain key bytes, no shared secret).
 */

import {
  KeyHierarchyValidationError,
  HierarchyNotFoundError,
  InvalidRootKeyError,
  ChainMismatchError,
  ChainRollbackError,
  MissingChainError,
  DuplicateChainError,
  CorruptedHierarchyError,
} from "../errors.js";
import { KH_KEY_BYTES, ChainStatus } from "../types/types.js";

const ALL_CHAIN_STATUSES = Object.values(ChainStatus);

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate a session-id reference. @throws {KeyHierarchyValidationError} */
export function validateSessionRef(sessionId) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) {
    throw new KeyHierarchyValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Require a hierarchy record. @throws {HierarchyNotFoundError} */
export function requireHierarchy(state, sessionId) {
  if (!state) throw new HierarchyNotFoundError("Key hierarchy not found", { details: { sessionId } });
  return state;
}

/** Assert a derived root key is a valid 32-byte buffer. @throws {InvalidRootKeyError} */
export function assertValidRootKey(rootKey) {
  if (!Buffer.isBuffer(rootKey) || rootKey.length !== KH_KEY_BYTES) {
    throw new InvalidRootKeyError("Root key must be a 32-byte buffer", { details: { length: rootKey?.length } });
  }
  return rootKey;
}

/** Require a chain to exist. @throws {MissingChainError} */
export function requireChain(chainMeta, role) {
  if (!chainMeta) throw new MissingChainError(`Missing ${role ?? ""} chain`.trim(), { details: { role } });
  return chainMeta;
}

/**
 * Assert a chain matches an expected direction/role/generation (chain-mismatch guard).
 * @param {object} chainMeta @param {{ direction?: string, role?: string, generation?: number }} expected
 * @throws {ChainMismatchError}
 */
export function assertChainMatch(chainMeta, expected = {}) {
  if (expected.direction && chainMeta.direction !== expected.direction) {
    throw new ChainMismatchError("Chain direction mismatch", { details: { expected: expected.direction, actual: chainMeta.direction } });
  }
  if (expected.role && chainMeta.role !== expected.role) {
    throw new ChainMismatchError("Chain role mismatch", { details: { expected: expected.role, actual: chainMeta.role } });
  }
  if (expected.generation != null && chainMeta.generation !== expected.generation) {
    throw new ChainMismatchError("Chain generation mismatch", { details: { expected: expected.generation, actual: chainMeta.generation } });
  }
  return chainMeta;
}

/**
 * Assert a chain-index advance is forward-only (rollback prevention).
 * @param {number} current @param {number} next @throws {ChainRollbackError}
 */
export function assertChainForward(current, next) {
  if (!Number.isInteger(current) || !Number.isInteger(next) || next <= current) {
    throw new ChainRollbackError(`Chain index must advance (from ${current})`, { details: { current, next } });
  }
  return next;
}

/**
 * Assert two chains are not duplicates (same direction + generation should be unique among
 * ACTIVE chains). @throws {DuplicateChainError}
 */
export function assertNoDuplicateChain(existing, candidate) {
  if (existing && existing.direction === candidate.direction && existing.generation === candidate.generation && existing.status === "active") {
    throw new DuplicateChainError("An active chain already exists for this direction + generation", {
      details: { direction: candidate.direction, generation: candidate.generation },
    });
  }
  return candidate;
}

/**
 * Validate a hierarchy record's metadata shape (detects corruption + forbidden key material).
 * @param {object} state @throws {CorruptedHierarchyError}
 */
export function validateHierarchyMetadata(state) {
  if (!state || typeof state !== "object") throw new CorruptedHierarchyError("Hierarchy record is not an object");
  for (const field of ["sessionId", "generation", "rootKey", "sendingChain", "receivingChain"]) {
    if (state[field] === undefined || state[field] === null) {
      throw new CorruptedHierarchyError(`Hierarchy is missing "${field}"`, { details: { field } });
    }
  }
  for (const chain of [state.sendingChain, state.receivingChain]) {
    if (!ALL_CHAIN_STATUSES.includes(chain.status)) throw new CorruptedHierarchyError(`Unknown chain status: ${chain.status}`);
    if (!Number.isInteger(chain.index) || chain.index < 0) throw new CorruptedHierarchyError("Chain index is malformed");
  }
  if (containsKeyMaterial(state)) throw new CorruptedHierarchyError("Hierarchy record must not contain raw key material");
  return state;
}

/** Whether an object graph carries anything that looks like secret key material. */
function containsKeyMaterial(state) {
  const forbidden = ["rootKeyBytes", "chainKey", "sendingKey", "receivingKey", "sharedSecret", "ratchetMaterial", "secret"];
  if (forbidden.some((k) => k in state)) return true;
  for (const chain of [state.rootKey, state.sendingChain, state.receivingChain]) {
    if (chain && (chain.bytes !== undefined || chain.key !== undefined || chain.secret !== undefined)) return true;
  }
  return false;
}

/** Validate a repository implements the required contract. @throws {KeyHierarchyValidationError} */
export function validateRepository(repo, methods = ["create", "findBySessionId", "update", "delete", "listAll"]) {
  if (!repo || typeof repo !== "object") throw new KeyHierarchyValidationError("Hierarchy repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new KeyHierarchyValidationError(`Hierarchy repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}

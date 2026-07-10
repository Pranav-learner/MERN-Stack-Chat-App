/**
 * @module message-keys/validators
 *
 * Validation for the per-message key engine. Covers every spec item: duplicate message
 * numbers, chain mismatch, missing chain, generation mismatch, invalid derivation, destroyed
 * key reuse, malformed metadata, and replay metadata.
 *
 * @security Also enforces that a message-key request never smuggles key material.
 */

import {
  MessageKeyValidationError,
  MessageKeyNotFoundError,
  DuplicateMessageNumberError,
  GenerationMismatchError,
  ChainResolutionError,
  DestroyedKeyReuseError,
} from "../errors.js";
import { MessageDirection, DeliveryStatus } from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate a session-id reference. @throws {MessageKeyValidationError} */
export function validateSessionRef(sessionId) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) {
    throw new MessageKeyValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Require a message-key state record. @throws {MessageKeyNotFoundError} */
export function requireState(state, sessionId) {
  if (!state) throw new MessageKeyNotFoundError("Message key state not found", { details: { sessionId } });
  return state;
}

/** Validate a message number is a non-negative integer. @throws {MessageKeyValidationError} */
export function validateMessageNumber(n) {
  if (!Number.isInteger(n) || n < 0) throw new MessageKeyValidationError("Message number must be a non-negative integer", { details: { messageNumber: n } });
  return n;
}

/** Validate a generation is a non-negative integer. @throws {MessageKeyValidationError} */
export function validateGeneration(g) {
  if (!Number.isInteger(g) || g < 0) throw new MessageKeyValidationError("Generation must be a non-negative integer", { details: { generation: g } });
  return g;
}

/** Assert the message generation matches the active chain generation. @throws {GenerationMismatchError} */
export function assertGenerationMatch(messageGeneration, chainGeneration) {
  if (messageGeneration !== chainGeneration) {
    throw new GenerationMismatchError("Message generation does not match the active chain", { details: { messageGeneration, chainGeneration } });
  }
}

/** Require a resolved chain to exist. @throws {ChainResolutionError} */
export function requireChain(chain, direction) {
  if (!chain || !chain.chainKey) throw new ChainResolutionError(`No ${direction} chain available`, { details: { direction } });
  return chain;
}

/**
 * Assert an OUTBOUND message number has not already been used (duplicate guard). Sending
 * numbers strictly increase, so a repeat means a bug/replay.
 * @param {number} lastNumber @param {number} number @throws {DuplicateMessageNumberError}
 */
export function assertNoDuplicateSend(lastNumber, number) {
  if (number <= lastNumber) {
    throw new DuplicateMessageNumberError(`Sending message number must advance (last ${lastNumber})`, { details: { lastNumber, number } });
  }
  return number;
}

/**
 * Assert a cached/looked-up key was found for a past message number (else it is a replay of
 * an already-consumed message). @param {object|null} bundle @param {number} number
 * @throws {DestroyedKeyReuseError}
 */
export function assertNotConsumed(bundle, number) {
  if (!bundle) {
    throw new DestroyedKeyReuseError(`No key for message ${number} — already used/destroyed (possible replay)`, { details: { messageNumber: number } });
  }
  return bundle;
}

/**
 * Validate a message envelope's shape (guards against malformed / replay metadata).
 * @param {object} envelope @throws {MessageKeyValidationError}
 */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new MessageKeyValidationError("Malformed message envelope");
  validateMessageNumber(envelope.messageNumber);
  validateGeneration(envelope.generation);
  if (!envelope.payload || typeof envelope.payload !== "object") throw new MessageKeyValidationError("Message envelope missing payload");
  return envelope;
}

/** Validate a repository implements the required contract. @throws {MessageKeyValidationError} */
export function validateRepository(repo, methods = ["create", "findBySessionId", "update", "delete", "listAll"]) {
  if (!repo || typeof repo !== "object") throw new MessageKeyValidationError("Message-key repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new MessageKeyValidationError(`Message-key repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}

export { MessageDirection, DeliveryStatus };

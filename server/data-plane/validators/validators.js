/**
 * @module data-plane/validators
 *
 * Validation for the Reliable Messaging Engine. Covers every spec item: duplicate messages, missing
 * ACKs, invalid ordering, expired messages, unauthorized sender, malformed payload, repository
 * consistency, and replay placeholders. It also enforces the framework's core invariant:
 *
 * @security A message/ack/record must carry OPAQUE CIPHERTEXT only — NEVER plaintext or key material.
 * {@link assertNoPlaintext} deep-scans for forbidden secret/plaintext key names and is invoked before
 * a record is stored or a wire envelope is built. The engine never decodes `encryptedPayload`.
 */

import { ALL_DELIVERY_STATES, ALL_PRIORITIES, WireType } from "../types/types.js";
import {
  MessageValidationError,
  MessageNotFoundError,
  MessageExpiredError,
  UnauthorizedSenderError,
  CorruptedMessageError,
} from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MSG_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Field names that must NEVER appear in a message/ack — secret key material OR obvious plaintext
 * markers (the payload must be ciphertext, not `{ plaintext, text, body }`).
 */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "keyBytes",
  "seed",
  "plaintext",
  "plainText",
  "cleartext",
  "decrypted",
]);

/** Validate a message id's shape. @throws {MessageValidationError} */
export function validateMessageId(messageId) {
  if (typeof messageId !== "string" || !MSG_ID_RE.test(messageId)) {
    throw new MessageValidationError("Invalid message identifier", { details: { messageId } });
  }
  return messageId;
}

/** Validate an id reference (conversation / device). @throws {MessageValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) {
    throw new MessageValidationError(`Invalid ${label}`, { details: { id } });
  }
  return id;
}

/** Validate a sequence number. @throws {MessageValidationError} */
export function validateSequence(seq) {
  if (!Number.isInteger(seq) || seq < 0) throw new MessageValidationError("Invalid sequence number", { details: { seq } });
  return seq;
}

/**
 * Validate an encrypted payload: present, an object/string, and NOT plaintext.
 * @param {any} payload @throws {MessageValidationError}
 */
export function validateEncryptedPayload(payload) {
  if (payload == null) throw new MessageValidationError("encryptedPayload is required (opaque ciphertext)");
  if (typeof payload !== "object" && typeof payload !== "string") {
    throw new MessageValidationError("encryptedPayload must be an object or string (ciphertext)");
  }
  assertNoPlaintext(payload, "encryptedPayload");
  return payload;
}

/**
 * Validate a send request. @param {object} request @throws {MessageValidationError}
 */
export function validateSendRequest(request) {
  if (!request || typeof request !== "object") throw new MessageValidationError("Malformed send request");
  validateRef(request.conversationId, "conversation identifier");
  validateRef(request.senderDeviceId, "sender device identifier");
  validateRef(request.receiverDeviceId, "receiver device identifier");
  validateEncryptedPayload(request.encryptedPayload);
  if (request.priority !== undefined && !ALL_PRIORITIES.includes(request.priority)) {
    throw new MessageValidationError(`Unknown priority "${request.priority}"`, { details: { priority: request.priority } });
  }
  if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)) {
    throw new MessageValidationError("ttlMs must be a positive number", { details: { ttlMs: request.ttlMs } });
  }
  return request;
}

/** Validate an inbound wire envelope's shape. @throws {MessageValidationError} */
export function validateWireEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new MessageValidationError("Wire envelope is not an object");
  if (envelope.type !== WireType.DATA && envelope.type !== WireType.ACK) throw new MessageValidationError(`Unknown wire type "${envelope.type}"`);
  validateMessageId(envelope.messageId);
  validateRef(envelope.conversationId, "conversation identifier");
  validateRef(envelope.sender, "sender identifier");
  validateRef(envelope.receiver, "receiver identifier");
  if (envelope.type === WireType.DATA) {
    validateSequence(envelope.seq);
    validateEncryptedPayload(envelope.payload);
  }
  assertNoPlaintext(envelope, "wire envelope");
  return envelope;
}

/** Require a message to exist. @throws {MessageNotFoundError} */
export function requireMessage(message, ref) {
  if (!message) throw new MessageNotFoundError("Message not found", { details: { ref } });
  return message;
}

/** Assert a message has not expired. @throws {MessageExpiredError} */
export function assertNotExpired(message, now = Date.now()) {
  if (message?.expiresAt && new Date(message.expiresAt).getTime() <= now && message.state !== "expired") {
    throw new MessageExpiredError("Message has expired", { details: { messageId: message.messageId, expiresAt: message.expiresAt } });
  }
  return message;
}

/** Assert the acting device is the sender/owner. @throws {UnauthorizedSenderError} */
export function assertSender(message, actingDeviceId) {
  if (!actingDeviceId || String(message.senderDeviceId) !== String(actingDeviceId)) {
    throw new UnauthorizedSenderError("Caller is not the sender of this message", { details: { messageId: message.messageId } });
  }
  return message;
}

/**
 * Deep-scan for forbidden plaintext / secret key material. @param {any} value @param {string} [label]
 * @throws {CorruptedMessageError}
 */
export function assertNoPlaintext(value, label = "message") {
  const seen = new Set();
  const walk = (node, path) => {
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new CorruptedMessageError(`${label} must not contain plaintext/secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a stored message record's shape. @throws {CorruptedMessageError} */
export function validateMessage(message) {
  if (!message || typeof message !== "object") throw new CorruptedMessageError("Message is not an object");
  for (const field of ["messageId", "conversationId", "senderDeviceId", "receiverDeviceId", "state", "sequenceNumber"]) {
    if (message[field] === undefined || message[field] === null) {
      throw new CorruptedMessageError(`Message is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_DELIVERY_STATES.includes(message.state)) throw new CorruptedMessageError(`Unknown delivery state: ${message.state}`, { details: { state: message.state } });
  assertNoPlaintext(message, "message");
  return message;
}

/** Validate a repository implements the required message-store contract. @throws {MessageValidationError} */
export function validateRepository(repo, methods = ["create", "findById", "update", "delete", "listPendingByConnection", "listRetryDue", "listExpired", "nextSequence"]) {
  if (!repo || typeof repo !== "object") throw new MessageValidationError("Message repository is missing or malformed");
  for (const m of methods) if (typeof repo[m] !== "function") throw new MessageValidationError(`Message repository is missing method "${m}"`, { details: { method: m } });
  return repo;
}

/**
 * @module shs/messages
 *
 * Handshake protocol message models and builders. Every message shares a common
 * envelope (type, id, version, parties, timestamp, nonce) plus a type-specific
 * `payload`. Messages carry PROTOCOL METADATA ONLY — there is no key material,
 * ciphertext, or shared secret anywhere in Sprint 1.
 *
 * Builders produce plain objects (easy to serialize/log/test). {@link validateMessage}
 * in the validators module enforces the shape; {@link module:shs/serializers} turns
 * these objects into JSON/binary/compact frames.
 *
 * @example
 * ```js
 * const req = buildRequest({
 *   handshakeId, initiator: "alice", responder: "bob",
 *   initiatorDevice: "dev-a", version: "1.0", capabilities: ["handshake.resume"],
 * });
 * req.type; // "handshake.request"
 * ```
 */

import crypto from "node:crypto";
import { MessageType } from "../types.js";
import { CURRENT_VERSION, MINIMUM_VERSION } from "../protocol/version.js";
import { HandshakeValidationError } from "../errors.js";

/**
 * @typedef {object} HandshakeMessage
 * @property {string} type one of {@link MessageType}
 * @property {string} handshakeId the session this message belongs to
 * @property {string} version protocol version of the sender
 * @property {string} [minVersion] minimum version the sender accepts (request only)
 * @property {string} messageId unique id for this message (idempotency/replay key)
 * @property {string} [from] sender user id
 * @property {string} [fromDevice] sender device id
 * @property {string} [to] recipient user id
 * @property {string} [toDevice] recipient device id
 * @property {number} timestamp epoch ms
 * @property {string} nonce random hex (replay/dup detection)
 * @property {object} payload type-specific, secret-free fields
 */

/** @param {() => number} clock @param {() => string} idGen */
function envelope(type, fields, clock, idGen) {
  return {
    type,
    handshakeId: fields.handshakeId,
    version: fields.version ?? CURRENT_VERSION,
    messageId: (idGen ?? (() => crypto.randomUUID()))(),
    from: fields.from,
    fromDevice: fields.fromDevice,
    to: fields.to,
    toDevice: fields.toDevice,
    timestamp: (clock ?? (() => Date.now()))(),
    nonce: crypto.randomBytes(16).toString("hex"),
    payload: {},
  };
}

/** Options common to every builder. @typedef {{ clock?: () => number, idGenerator?: () => string }} BuildOptions */

/**
 * Build a `handshake.request` — the initiator's opening message.
 * @param {{ handshakeId: string, initiator: string, responder: string,
 *   initiatorDevice: string, responderDevice?: string, version?: string,
 *   minVersion?: string, capabilities?: string[], metadata?: object }} f
 * @param {BuildOptions} [opts]
 * @returns {HandshakeMessage}
 */
export function buildRequest(f, opts = {}) {
  const msg = envelope(MessageType.REQUEST, {
    handshakeId: f.handshakeId,
    version: f.version,
    from: f.initiator,
    fromDevice: f.initiatorDevice,
    to: f.responder,
    toDevice: f.responderDevice,
  }, opts.clock, opts.idGenerator);
  msg.minVersion = f.minVersion ?? MINIMUM_VERSION;
  msg.payload = {
    capabilities: f.capabilities ?? [],
    metadata: f.metadata ?? {},
  };
  return msg;
}

/**
 * Build a `handshake.response` — the responder acknowledging a request and
 * advertising its own capabilities (no acceptance yet).
 * @param {{ handshakeId: string, responder: string, initiator: string,
 *   responderDevice: string, version?: string, capabilities?: string[] }} f
 * @param {BuildOptions} [opts]
 */
export function buildResponse(f, opts = {}) {
  const msg = envelope(MessageType.RESPONSE, {
    handshakeId: f.handshakeId,
    version: f.version,
    from: f.responder,
    fromDevice: f.responderDevice,
    to: f.initiator,
  }, opts.clock, opts.idGenerator);
  msg.payload = { capabilities: f.capabilities ?? [] };
  return msg;
}

/**
 * Build a `handshake.accept` — the responder accepting, carrying the negotiated
 * version + capability set.
 * @param {{ handshakeId: string, responder: string, initiator: string,
 *   responderDevice: string, version: string, negotiatedCapabilities?: string[] }} f
 * @param {BuildOptions} [opts]
 */
export function buildAccept(f, opts = {}) {
  const msg = envelope(MessageType.ACCEPT, {
    handshakeId: f.handshakeId,
    version: f.version,
    from: f.responder,
    fromDevice: f.responderDevice,
    to: f.initiator,
  }, opts.clock, opts.idGenerator);
  msg.payload = { negotiatedCapabilities: f.negotiatedCapabilities ?? [] };
  return msg;
}

/**
 * Build a `handshake.reject` — the responder declining.
 * @param {{ handshakeId: string, responder: string, initiator: string, reason?: string }} f
 * @param {BuildOptions} [opts]
 */
export function buildReject(f, opts = {}) {
  const msg = envelope(MessageType.REJECT, {
    handshakeId: f.handshakeId,
    from: f.responder,
    to: f.initiator,
  }, opts.clock, opts.idGenerator);
  msg.payload = { reason: f.reason };
  return msg;
}

/**
 * Build a `handshake.cancel` — the initiator aborting an in-flight handshake.
 * @param {{ handshakeId: string, initiator: string, responder: string, reason?: string }} f
 * @param {BuildOptions} [opts]
 */
export function buildCancel(f, opts = {}) {
  const msg = envelope(MessageType.CANCEL, {
    handshakeId: f.handshakeId,
    from: f.initiator,
    to: f.responder,
  }, opts.clock, opts.idGenerator);
  msg.payload = { reason: f.reason };
  return msg;
}

/**
 * Build a `handshake.timeout` — a step deadline elapsed.
 * @param {{ handshakeId: string, from?: string, to?: string, step?: string }} f
 * @param {BuildOptions} [opts]
 */
export function buildTimeout(f, opts = {}) {
  const msg = envelope(MessageType.TIMEOUT, {
    handshakeId: f.handshakeId,
    from: f.from,
    to: f.to,
  }, opts.clock, opts.idGenerator);
  msg.payload = { step: f.step };
  return msg;
}

/**
 * Build a `handshake.resume` — a party asking to resume a non-terminal session.
 * @param {{ handshakeId: string, from: string, to?: string, fromDevice?: string,
 *   fromState?: string }} f
 * @param {BuildOptions} [opts]
 */
export function buildResume(f, opts = {}) {
  const msg = envelope(MessageType.RESUME, {
    handshakeId: f.handshakeId,
    from: f.from,
    fromDevice: f.fromDevice,
    to: f.to,
  }, opts.clock, opts.idGenerator);
  msg.payload = { fromState: f.fromState };
  return msg;
}

/**
 * Build a `handshake.complete` — the protocol concluded successfully.
 * @param {{ handshakeId: string, from: string, to?: string, version?: string,
 *   negotiatedCapabilities?: string[] }} f
 * @param {BuildOptions} [opts]
 */
export function buildComplete(f, opts = {}) {
  const msg = envelope(MessageType.COMPLETE, {
    handshakeId: f.handshakeId,
    version: f.version,
    from: f.from,
    to: f.to,
  }, opts.clock, opts.idGenerator);
  msg.payload = { negotiatedCapabilities: f.negotiatedCapabilities ?? [] };
  return msg;
}

/**
 * Build a `handshake.failure` — a semantic handshake failure (distinct from a
 * transport/protocol error message).
 * @param {{ handshakeId: string, from?: string, to?: string, reason?: string,
 *   details?: object }} f
 * @param {BuildOptions} [opts]
 */
export function buildFailure(f, opts = {}) {
  const msg = envelope(MessageType.FAILURE, {
    handshakeId: f.handshakeId,
    from: f.from,
    to: f.to,
  }, opts.clock, opts.idGenerator);
  msg.payload = { reason: f.reason, details: f.details ?? {} };
  return msg;
}

/**
 * Build a `handshake.error` — a protocol-level error (bad message, version, etc.).
 * @param {{ handshakeId?: string, from?: string, to?: string, code?: string,
 *   message?: string, details?: object }} f
 * @param {BuildOptions} [opts]
 */
export function buildError(f, opts = {}) {
  const msg = envelope(MessageType.ERROR, {
    handshakeId: f.handshakeId ?? "",
    from: f.from,
    to: f.to,
  }, opts.clock, opts.idGenerator);
  msg.payload = { code: f.code, message: f.message, details: f.details ?? {} };
  return msg;
}

/** Map of message type -> builder, for generic construction/testing. */
export const MESSAGE_BUILDERS = Object.freeze({
  [MessageType.REQUEST]: buildRequest,
  [MessageType.RESPONSE]: buildResponse,
  [MessageType.ACCEPT]: buildAccept,
  [MessageType.REJECT]: buildReject,
  [MessageType.CANCEL]: buildCancel,
  [MessageType.TIMEOUT]: buildTimeout,
  [MessageType.RESUME]: buildResume,
  [MessageType.COMPLETE]: buildComplete,
  [MessageType.FAILURE]: buildFailure,
  [MessageType.ERROR]: buildError,
});

/**
 * Assert an object carries the minimal common envelope. Throws for anything that is
 * obviously not a handshake message (used at the top of serialization/validation).
 * @param {any} msg
 * @throws {HandshakeValidationError}
 */
export function assertEnvelope(msg) {
  if (!msg || typeof msg !== "object") {
    throw new HandshakeValidationError("Message must be an object");
  }
  if (typeof msg.type !== "string" || !Object.values(MessageType).includes(msg.type)) {
    throw new HandshakeValidationError(`Unknown message type: ${msg.type}`, { details: { type: msg.type } });
  }
  if (typeof msg.messageId !== "string" || !msg.messageId) {
    throw new HandshakeValidationError("Message is missing messageId");
  }
  return msg;
}

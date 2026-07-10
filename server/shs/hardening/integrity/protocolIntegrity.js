/**
 * @module shs/hardening/integrity/protocolIntegrity
 *
 * Protocol-integrity validation. Strengthens the Sprint 1 message/serialization
 * checks with cross-message and cross-state guarantees:
 *
 *   - **Headers/metadata** — the message envelope + declared version are well-formed.
 *   - **Message ordering** — each message type is only accepted in the states/order
 *     the protocol expects (an out-of-order or unexpected message is rejected).
 *   - **State consistency** — a message's implied progression matches the session's
 *     recorded state.
 *   - **Unexpected transitions** — a state change not permitted by the FSM is flagged.
 *   - **Malformed payload / corrupted serialization** — delegated to the Sprint 1
 *     serializer + validators, surfaced here as integrity violations.
 *
 * It also maintains a running **transcript hash** over a handshake's messages so the
 * message stream is tamper-evident (a future authenticated binding can sign it).
 *
 * @security Public metadata only. This is defence-in-depth over the existing Sprint 1
 * validators; it does not replace them.
 */

import crypto from "node:crypto";
import { MessageType, HandshakeState } from "../../types.js";
import { canTransition } from "../../state-machine/stateMachine.js";
import { validateMessage } from "../../validators/validators.js";
import { IntegrityReason } from "../types.js";
import { ProtocolIntegrityError } from "../errors.js";

/**
 * The message types expected while a handshake session is in each state. Used for
 * ordering/state-consistency checks (an inbound message whose type isn't expected for
 * the current state is out-of-order).
 * @type {Readonly<Record<string, string[]>>}
 */
export const EXPECTED_MESSAGES_BY_STATE = Object.freeze({
  [HandshakeState.WAITING]: [MessageType.REQUEST, MessageType.RESPONSE, MessageType.ACCEPT, MessageType.REJECT, MessageType.CANCEL, MessageType.RESUME, MessageType.ERROR],
  [HandshakeState.NEGOTIATING]: [MessageType.ACCEPT, MessageType.COMPLETE, MessageType.REJECT, MessageType.CANCEL, MessageType.FAILURE, MessageType.RESUME, MessageType.ERROR],
  [HandshakeState.GENERATING_EPHEMERAL_KEYS]: [MessageType.CANCEL, MessageType.FAILURE, MessageType.ERROR, MessageType.RESUME],
  [HandshakeState.WAITING_FOR_PEER_KEY]: [MessageType.CANCEL, MessageType.FAILURE, MessageType.ERROR, MessageType.RESUME],
  [HandshakeState.DERIVING_SHARED_SECRET]: [MessageType.COMPLETE, MessageType.CANCEL, MessageType.FAILURE, MessageType.ERROR],
  [HandshakeState.SHARED_SECRET_ESTABLISHED]: [MessageType.COMPLETE, MessageType.FAILURE, MessageType.ERROR],
});

/**
 * Validate a message's structural integrity (envelope + version + payload). Wraps the
 * Sprint 1 {@link validateMessage} and re-labels failures as integrity violations.
 * @param {object} message @param {object} [options]
 * @throws {ProtocolIntegrityError}
 */
export function validateHeaders(message, options = {}) {
  try {
    return validateMessage(message, options);
  } catch (error) {
    throw new ProtocolIntegrityError(`Message header/metadata invalid: ${error.message}`, {
      cause: error,
      details: { reason: IntegrityReason.BAD_HEADER, code: error.code },
    });
  }
}

/**
 * Validate a message is expected for the session's current state (ordering + state
 * consistency).
 * @param {object} message @param {object} session the stored handshake session
 * @throws {ProtocolIntegrityError}
 */
export function validateOrdering(message, session) {
  if (!session) {
    throw new ProtocolIntegrityError("No session for ordering check", { details: { reason: IntegrityReason.STATE_INCONSISTENT } });
  }
  if (message.handshakeId !== session.handshakeId) {
    throw new ProtocolIntegrityError("Message/session handshakeId mismatch", { details: { reason: IntegrityReason.STATE_INCONSISTENT } });
  }
  const expected = EXPECTED_MESSAGES_BY_STATE[session.state];
  // States with no explicit expectation (terminal, created, initialized) accept none.
  if (!expected || !expected.includes(message.type)) {
    throw new ProtocolIntegrityError(`Unexpected message "${message.type}" in state "${session.state}"`, {
      details: { reason: IntegrityReason.UNEXPECTED_MESSAGE, state: session.state, type: message.type },
    });
  }
  return true;
}

/**
 * Validate a proposed state transition is permitted by the FSM (defence-in-depth over
 * the manager's own guard).
 * @param {string} from @param {string} to @throws {ProtocolIntegrityError}
 */
export function validateTransition(from, to) {
  if (from !== to && !canTransition(from, to)) {
    throw new ProtocolIntegrityError(`Unexpected transition ${from} → ${to}`, {
      details: { reason: IntegrityReason.UNEXPECTED_TRANSITION, from, to },
    });
  }
  return true;
}

/**
 * Validate session metadata is internally consistent (participants, ids, timestamps).
 * @param {object} session @throws {ProtocolIntegrityError}
 */
export function validateSessionMetadata(session) {
  if (!session || typeof session !== "object") {
    throw new ProtocolIntegrityError("Session is not an object", { details: { reason: IntegrityReason.BAD_METADATA } });
  }
  for (const field of ["handshakeId", "initiator", "responder", "state"]) {
    if (!session[field]) {
      throw new ProtocolIntegrityError(`Session missing "${field}"`, { details: { reason: IntegrityReason.BAD_METADATA, field } });
    }
  }
  if (String(session.initiator) === String(session.responder)) {
    throw new ProtocolIntegrityError("Session initiator == responder", { details: { reason: IntegrityReason.BAD_METADATA } });
  }
  if (session.createdAt && session.updatedAt && new Date(session.updatedAt) < new Date(session.createdAt)) {
    throw new ProtocolIntegrityError("Session updatedAt precedes createdAt", { details: { reason: IntegrityReason.BAD_METADATA } });
  }
  return true;
}

/**
 * A running transcript accumulator: folds each message into a chained SHA-256 so the
 * ordered message stream is tamper-evident. Per handshake.
 *
 * @example
 * ```js
 * const t = new TranscriptAccumulator(handshakeId);
 * t.append(requestMsg); t.append(acceptMsg);
 * t.digest; // hex chaining all messages so far, order-sensitive
 * ```
 */
export class TranscriptAccumulator {
  /** @param {string} handshakeId */
  constructor(handshakeId) {
    this.handshakeId = handshakeId;
    this._digest = crypto.createHash("sha256").update("SHS-transcript-v1").update(String(handshakeId)).digest("hex");
    this._count = 0;
  }

  /** Fold a message (its type + id + nonce + version) into the transcript. */
  append(message) {
    const frame = `${message.type}|${message.messageId ?? ""}|${message.nonce ?? ""}|${message.version ?? ""}`;
    this._digest = crypto.createHash("sha256").update(this._digest).update("|").update(frame).digest("hex");
    this._count++;
    return this._digest;
  }

  /** The current transcript digest (hex). */
  get digest() {
    return this._digest;
  }

  /** How many messages have been folded in. */
  get length() {
    return this._count;
  }

  /** Compare against another digest (constant-time). */
  matches(other) {
    const a = Buffer.from(this._digest);
    const b = Buffer.from(String(other));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

/**
 * Full inbound-message integrity check: headers → ordering → (optional) transcript.
 * @param {object} message @param {object} session
 * @param {{ allowUnsupportedVersion?: boolean, transcript?: TranscriptAccumulator }} [options]
 * @throws {ProtocolIntegrityError}
 */
export function verifyInboundMessage(message, session, options = {}) {
  validateHeaders(message, options);
  validateSessionMetadata(session);
  validateOrdering(message, session);
  if (options.transcript) options.transcript.append(message);
  return true;
}

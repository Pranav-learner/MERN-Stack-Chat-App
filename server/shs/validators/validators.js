/**
 * @module shs/validators
 *
 * Protocol validation for the Secure Handshake System. Validates message shape,
 * message types, protocol versions, session references, party existence (unknown
 * identity/device), expiry, malformed payloads, and duplicate messages.
 *
 * State-transition validation lives in {@link module:shs/state-machine}; this module
 * covers everything else and delegates to it where needed.
 */

import { MessageType, isTerminalState } from "../types.js";
import { isCompatible, isSupported, parseVersion } from "../protocol/version.js";
import {
  HandshakeValidationError,
  ProtocolVersionError,
  HandshakeExpiredError,
  DuplicateHandshakeError,
  UnknownPartyError,
} from "../errors.js";
import { assertEnvelope } from "../messages/messages.js";

/** Required (non-envelope) payload keys per message type. */
const REQUIRED_FIELDS = Object.freeze({
  [MessageType.REQUEST]: { top: ["handshakeId", "from", "fromDevice", "to", "version", "minVersion"] },
  [MessageType.RESPONSE]: { top: ["handshakeId", "from", "to", "version"] },
  [MessageType.ACCEPT]: { top: ["handshakeId", "from", "to", "version"] },
  [MessageType.REJECT]: { top: ["handshakeId", "from"] },
  [MessageType.CANCEL]: { top: ["handshakeId", "from"] },
  [MessageType.TIMEOUT]: { top: ["handshakeId"] },
  [MessageType.RESUME]: { top: ["handshakeId", "from"] },
  [MessageType.COMPLETE]: { top: ["handshakeId", "from"] },
  [MessageType.FAILURE]: { top: ["handshakeId"] },
  [MessageType.ERROR]: { top: [] },
});

/**
 * Validate a decoded handshake message's structure and version. Does NOT check
 * against a stored session (see {@link validateAgainstSession}).
 * @param {object} message
 * @param {{ allowUnsupportedVersion?: boolean }} [options]
 * @returns {object} the validated message
 * @throws {HandshakeValidationError | ProtocolVersionError}
 */
export function validateMessage(message, options = {}) {
  assertEnvelope(message);

  if (typeof message.handshakeId !== "string" && message.type !== MessageType.ERROR) {
    throw new HandshakeValidationError("Message missing handshakeId", { details: { type: message.type } });
  }
  if (typeof message.nonce !== "string" || !/^[0-9a-f]+$/i.test(message.nonce)) {
    throw new HandshakeValidationError("Message missing/invalid nonce");
  }
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    throw new HandshakeValidationError("Message missing/invalid timestamp");
  }
  if (message.payload === undefined || message.payload === null || typeof message.payload !== "object") {
    throw new HandshakeValidationError("Message missing payload object");
  }

  const spec = REQUIRED_FIELDS[message.type];
  for (const key of spec.top) {
    if (message[key] === undefined || message[key] === null || message[key] === "") {
      throw new HandshakeValidationError(`Message ${message.type} missing "${key}"`, {
        details: { type: message.type, field: key },
      });
    }
  }

  // Version checks (skip for pure ERROR frames which may predate negotiation).
  if (message.version !== undefined && message.type !== MessageType.ERROR) {
    parseVersion(message.version); // throws ProtocolVersionError if malformed
    if (!options.allowUnsupportedVersion && !isSupported(message.version)) {
      throw new ProtocolVersionError(`Unsupported protocol version: ${message.version}`, {
        details: { version: message.version },
      });
    }
  }
  return message;
}

/**
 * Validate a version pair is mutually compatible.
 * @param {string} local @param {string} remote
 * @throws {ProtocolVersionError}
 */
export function validateVersionCompatibility(local, remote) {
  if (!isCompatible(local, remote)) {
    throw new ProtocolVersionError(`Incompatible versions: ${local} vs ${remote}`, {
      details: { local, remote },
    });
  }
}

/**
 * Validate a message references a live, matching session.
 * @param {object} message
 * @param {object} session the stored {@link HandshakeSession}
 * @param {{ now?: number }} [options]
 * @throws {HandshakeValidationError | HandshakeExpiredError}
 */
export function validateAgainstSession(message, session, options = {}) {
  if (!session) {
    throw new HandshakeValidationError("No session for message", { details: { handshakeId: message.handshakeId } });
  }
  if (message.handshakeId !== session.handshakeId) {
    throw new HandshakeValidationError("Message handshakeId does not match session");
  }
  const now = options.now ?? Date.now();
  if (isExpired(session, now) && !isTerminalState(session.state)) {
    throw new HandshakeExpiredError("Session expired", { details: { handshakeId: session.handshakeId } });
  }
}

/**
 * Validate the parties of a start request exist and are usable. Uses optional
 * lookups (identity/device directory); when a lookup is absent, that check is
 * skipped (future sprints will always wire them).
 *
 * @param {{ initiator: string, responder: string, initiatorDevice?: string, responderDevice?: string }} req
 * @param {{ identityLookup?: (userId: string) => Promise<object|null>,
 *           deviceLookup?: (userId: string, deviceId: string) => Promise<object|null> }} [lookups]
 * @throws {HandshakeValidationError | UnknownPartyError}
 */
export async function validateParties(req, lookups = {}) {
  if (!req.initiator || !req.responder) {
    throw new HandshakeValidationError("initiator and responder are required");
  }
  if (String(req.initiator) === String(req.responder)) {
    throw new HandshakeValidationError("Cannot start a handshake with yourself");
  }
  if (lookups.identityLookup) {
    for (const user of [req.initiator, req.responder]) {
      const identity = await lookups.identityLookup(user);
      if (!identity) {
        throw new UnknownPartyError(`No identity for user ${user}`, { details: { userId: String(user) } });
      }
    }
  }
  if (lookups.deviceLookup && req.initiatorDevice) {
    const device = await lookups.deviceLookup(req.initiator, req.initiatorDevice);
    if (!device) {
      throw new UnknownPartyError(`Unknown initiator device ${req.initiatorDevice}`, {
        details: { deviceId: req.initiatorDevice },
      });
    }
  }
}

/**
 * Duplicate/replay guard. Given the set of message ids/nonces already seen for a
 * session, throw if this message was seen before.
 * @param {object} message @param {Set<string>|{ has: (k: string) => boolean }} seen
 * @throws {DuplicateHandshakeError}
 */
export function assertNotDuplicate(message, seen) {
  const key = message.messageId ?? message.nonce;
  if (seen && key && seen.has(key)) {
    throw new DuplicateHandshakeError("Duplicate handshake message", { details: { messageId: key } });
  }
}

/** Whether a session is past its expiry deadline. @param {object} session @param {number} [now] */
export function isExpired(session, now = Date.now()) {
  if (!session?.expiresAt) return false;
  return new Date(session.expiresAt).getTime() <= now;
}

/** Assert a session is not expired. @throws {HandshakeExpiredError} */
export function assertNotExpired(session, now = Date.now()) {
  if (isExpired(session, now) && !isTerminalState(session.state)) {
    throw new HandshakeExpiredError("Session expired", { details: { handshakeId: session?.handshakeId } });
  }
}

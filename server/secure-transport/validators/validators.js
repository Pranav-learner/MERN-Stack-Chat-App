/**
 * @module secure-transport/validators
 *
 * Validation for the Secure Transport Layer. Two audiences:
 *
 * - **Device** (encrypt/decrypt): full structural + version checks (integrity is the
 *   decryptor's job, since it needs keys).
 * - **Relay** (the server): {@link validateForRelay} — the server validates a payload's
 *   STRUCTURE, version, size, and that it carries NO plaintext, then routes/persists it.
 *   The server CANNOT verify integrity or decrypt (it has no keys) — by design.
 *
 * Covers: malformed payloads, wrong session/device/identity, corrupted ciphertext
 * (shape), version mismatch, integrity presence, and replay metadata.
 */

import { PAYLOAD_ENVELOPE_VERSION, ENCRYPTED_MESSAGE_TYPES } from "../types.js";
import { metadataOf, assertSecurePayloadShape } from "../payload/securePayload.js";
import { validateMetadata, replayKey } from "../metadata/metadata.js";
import { MalformedPayloadError, VersionMismatchError, SessionMismatchError } from "../errors.js";

/** Supported envelope versions (for forward/backward compatibility policy). */
export const SUPPORTED_ENVELOPE_VERSIONS = new Set([PAYLOAD_ENVELOPE_VERSION]);

/**
 * Validate a payload's version is supported.
 * @param {object} payload @throws {VersionMismatchError}
 */
export function validateVersion(payload) {
  if (!SUPPORTED_ENVELOPE_VERSIONS.has(payload.v)) {
    throw new VersionMismatchError(`Unsupported secure payload version: ${payload.v}`, { details: { version: payload.v } });
  }
  if (payload.type && !ENCRYPTED_MESSAGE_TYPES.includes(payload.type)) {
    throw new MalformedPayloadError(`Unknown message type: ${payload.type}`, { details: { type: payload.type } });
  }
  return payload;
}

/**
 * Server-side relay validation. The server confirms the payload is a well-formed,
 * supported, plaintext-free SecurePayload bound to the claimed session/devices — then
 * relays it. It does NOT (and cannot) verify integrity or decrypt.
 *
 * @param {object} payload
 * @param {{ sessionId?: string, senderDevice?: string }} [expected] values the server
 *   knows from the authenticated request (defends against a spoofed binding)
 * @returns {object} the validated metadata
 * @throws {MalformedPayloadError | VersionMismatchError | SessionMismatchError}
 */
export function validateForRelay(payload, expected = {}) {
  assertSecurePayloadShape(payload); // includes the "no plaintext" check
  validateVersion(payload);
  const meta = validateMetadata(metadataOf(payload));
  if (expected.sessionId && String(expected.sessionId) !== meta.sessionId) {
    throw new SessionMismatchError("Payload sessionId does not match the request session");
  }
  if (expected.senderDevice && meta.senderDevice && String(expected.senderDevice) !== meta.senderDevice) {
    throw new SessionMismatchError("Payload senderDevice does not match the authenticated device");
  }
  return meta;
}

/**
 * Replay-metadata check against a "seen" set (nonce is unique per message). Optional —
 * the transport can wire the Sprint 4 ReplayProtector here.
 * @param {object} payload @param {{ has: (k: string) => boolean, add: (k: string) => any }} seen
 * @returns {boolean} true if fresh (and records it), false if a replay
 */
export function checkReplay(payload, seen) {
  const key = replayKey(metadataOf(payload));
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Whether a value is a plaintext (unencrypted) message rather than a secure payload. */
export function looksLikePlaintext(obj) {
  return !!(obj && typeof obj === "object" && (obj.text !== undefined || obj.image !== undefined) && !obj.encryption);
}

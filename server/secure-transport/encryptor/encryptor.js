/**
 * @module secure-transport/encryptor
 *
 * The **encryption pipeline**:
 *
 * ```
 * Application Message → Load Encryption Keys → Encrypt (AES-256-GCM) → Secure Payload
 * ```
 *
 * Turns a plaintext application message + the session's device-local keys into a
 * {@link SecurePayload} that contains only ciphertext + authenticated metadata.
 *
 * @security The plaintext exists only transiently as a `Buffer` and is zero-filled
 * after sealing. Keys are supplied by the caller (Sprint 3 `loadSessionKeys`) and are
 * never retained here. The metadata is bound as AAD, so it is tamper-evident.
 */

import { buildMetadata, canonicalAAD } from "../metadata/metadata.js";
import { assembleSecurePayload } from "../payload/securePayload.js";
import { seal } from "../crypto/aead.js";
import { SessionKeyError } from "../errors.js";
import { MessageType } from "../types.js";

/**
 * Encrypt an application message into a {@link SecurePayload}.
 *
 * @param {object} message the plaintext application message (e.g. `{ text, image }`)
 * @param {import("../types.js").SessionKeys} keys device-local session keys
 * @param {object} context
 * @param {string} context.sessionId @param {string} [context.senderDevice] @param {string} [context.receiverDevice]
 * @param {string} [context.type=MessageType.MESSAGE] @param {string} [context.protocolVersion]
 * @param {() => number} [context.clock]
 * @returns {import("../types.js").SecurePayload}
 * @throws {SessionKeyError} if the keys are missing/invalid
 *
 * @example
 * ```js
 * const keys = secureSessionManager.loadSessionKeys(sessionId); // device-local
 * const payload = encryptMessage({ text: "hi" }, keys, { sessionId, senderDevice, receiverDevice });
 * // payload has ciphertext only — safe to hand to any transport / the relay
 * ```
 */
export function encryptMessage(message, keys, context) {
  assertKeys(keys);
  const meta = buildMetadata({
    sessionId: context.sessionId,
    keyId: keys.keyId,
    senderDevice: context.senderDevice,
    receiverDevice: context.receiverDevice,
    type: context.type ?? MessageType.MESSAGE,
    protocolVersion: context.protocolVersion,
    clock: context.clock,
  });
  const aad = canonicalAAD(meta);
  const plaintext = Buffer.from(JSON.stringify(message ?? {}), "utf8");
  try {
    const sealed = seal({ encryptionKey: keys.encryptionKey, macKey: keys.macKey, plaintext, aad });
    return assembleSecurePayload(meta, sealed);
  } finally {
    plaintext.fill(0); // dispose the transient plaintext buffer
  }
}

/** Validate the session keys are present + correctly sized. @throws {SessionKeyError} */
export function assertKeys(keys) {
  if (!keys || !Buffer.isBuffer(keys.encryptionKey) || !Buffer.isBuffer(keys.macKey)) {
    throw new SessionKeyError("Session encryption/MAC keys are required to encrypt");
  }
  if (keys.encryptionKey.length !== 32 || keys.macKey.length !== 32) {
    throw new SessionKeyError("Session keys must be 32 bytes each");
  }
  if (!keys.keyId) throw new SessionKeyError("Session keys are missing a keyId");
}

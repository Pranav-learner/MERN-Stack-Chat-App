/**
 * @module forward-secrecy/transport
 *
 * **Secure Transport integration.** Wires the Forward Secrecy Engine into the Layer 4
 * Secure Transport encryptor/decryptor so that encryption always uses the LATEST active
 * generation, and decryption resolves the correct generation from the payload's `keyId`:
 *
 * ```
 * encrypt:  message ─▶ resolve CURRENT generation ─▶ load current keys ─▶ AES-256-GCM ─▶ SecurePayload
 * decrypt:  SecurePayload ─▶ read metadata.keyId ─▶ resolve THAT generation's keys ─▶ open
 * ```
 *
 * Every evolution automatically shifts which keys `resolveEncryptionKeys` returns, so new
 * messages are sealed under fresh key material with zero transport-layer changes.
 *
 * @security The device keys never leave the {@link ForwardSecrecyManager}'s key store.
 * If a payload was sealed under a generation whose keys have already been destroyed (aged
 * out of the retention window), decryption fails closed — no plaintext is produced.
 */

import { encryptMessage } from "../../secure-transport/encryptor/encryptor.js";
import { decryptMessage } from "../../secure-transport/decryptor/decryptor.js";
import { metadataOf } from "../../secure-transport/payload/securePayload.js";
import { DestroyedKeyReferenceError } from "../errors.js";

/**
 * Encrypt an application message under the session's CURRENT generation keys.
 * @param {object} message the plaintext application message
 * @param {object} context `{ sessionId, senderDevice?, receiverDevice?, type?, protocolVersion?, clock? }`
 * @param {{ forwardSecrecy: import("../manager/forwardSecrecyManager.js").ForwardSecrecyManager }} deps
 * @returns {object} a SecurePayload (ciphertext only)
 */
export function encryptWithForwardSecrecy(message, context, deps) {
  const keys = deps.forwardSecrecy.resolveEncryptionKeys(context.sessionId);
  return encryptMessage(message, keys, context);
}

/**
 * Decrypt a SecurePayload, resolving the generation that sealed it from its `keyId`.
 * @param {object} payload the received SecurePayload
 * @param {{ forwardSecrecy: import("../manager/forwardSecrecyManager.js").ForwardSecrecyManager }} deps
 * @param {{ expectedSessionId?: string, expectedReceiverDevice?: string }} [options]
 * @returns {object} the decrypted application message
 * @throws {DestroyedKeyReferenceError} if that generation's keys were already destroyed
 */
export function decryptWithForwardSecrecy(payload, deps, options = {}) {
  const meta = metadataOf(payload);
  const sessionId = options.expectedSessionId ?? meta.sessionId;
  const keys = deps.forwardSecrecy.resolveDecryptionKeys(sessionId, { keyId: meta.keyId });
  if (!keys) {
    throw new DestroyedKeyReferenceError("No key material for the payload's generation (destroyed or out of retention window)", {
      details: { sessionId, keyId: meta.keyId },
    });
  }
  return decryptMessage(payload, keys, options);
}

/**
 * A key provider compatible with {@link SecureTransportManager} (`keyProvider(sessionId)`),
 * returning the CURRENT generation keys. Suitable for encryption and for decrypting
 * current-generation payloads; for older (retained) generations use
 * {@link decryptWithForwardSecrecy}, which resolves by `keyId`.
 * @param {import("../manager/forwardSecrecyManager.js").ForwardSecrecyManager} forwardSecrecy
 * @returns {(sessionId: string) => object}
 */
export function createForwardSecrecyKeyProvider(forwardSecrecy) {
  return (sessionId) => forwardSecrecy.resolveEncryptionKeys(sessionId);
}

/**
 * A forward-secrecy-aware encryption interceptor for the session-integration hook. Seals
 * an outbound envelope's `payload` under the current generation and opens an inbound one
 * by resolving the generation from its metadata. Swappable via
 * `setEncryptionInterceptor` (Layer 4 Sprint 5 hook) without changing the pipeline.
 * @param {{ forwardSecrecy: import("../manager/forwardSecrecyManager.js").ForwardSecrecyManager }} deps
 * @returns {{ name: string, encryptOutbound: Function, decryptInbound: Function }}
 */
export function createForwardSecrecyInterceptor(deps) {
  return {
    name: "forward-secrecy",
    encryptOutbound(envelope, context = {}) {
      const sessionId = context.sessionId ?? envelope.sessionId;
      const encryption = encryptWithForwardSecrecy(envelope.payload ?? {}, { ...context, sessionId }, deps);
      return { ...envelope, secured: true, encryption };
    },
    decryptInbound(envelope, context = {}) {
      if (!envelope.secured || !envelope.encryption) return envelope;
      const payload = decryptWithForwardSecrecy(envelope.encryption, deps, { expectedSessionId: context.sessionId ?? envelope.sessionId });
      return { ...envelope, payload };
    },
  };
}

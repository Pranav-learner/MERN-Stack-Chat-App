/**
 * @module secure-transport/decryptor
 *
 * The **decryption pipeline**:
 *
 * ```
 * Receive Payload → Validate → Load Session Keys → Decrypt → Integrity Check → Plaintext
 * ```
 *
 * Verifies a {@link SecurePayload}'s structure, then (with the device-local keys)
 * verifies integrity (HMAC + AEAD tag + AAD-bound metadata) and returns the plaintext
 * application message. Any malformed / corrupted / wrong-key / wrong-session payload is
 * rejected.
 *
 * @security The decrypted plaintext is returned to the caller; the transient decoded
 * buffers are dropped. Keys are supplied by the caller and never retained. A failed
 * integrity check is fatal — no partial plaintext is returned.
 */

import { canonicalAAD, validateMetadata } from "../metadata/metadata.js";
import { decodeSecurePayload, metadataOf, assertSecurePayloadShape } from "../payload/securePayload.js";
import { open } from "../crypto/aead.js";
import { assertKeys } from "../encryptor/encryptor.js";
import { MalformedPayloadError, SessionMismatchError, IntegrityError } from "../errors.js";

/**
 * Decrypt a {@link SecurePayload} back to the application message.
 *
 * @param {object} payload the received secure payload
 * @param {import("../types.js").SessionKeys} keys device-local session keys
 * @param {{ expectedSessionId?: string, expectedKeyId?: string, expectedReceiverDevice?: string }} [options]
 * @returns {object} the decrypted application message
 * @throws {MalformedPayloadError | IntegrityError | SessionMismatchError}
 *
 * @example
 * ```js
 * const keys = secureSessionManager.loadSessionKeys(payload.sessionId);
 * const message = decryptMessage(payload, keys); // { text: "hi" }
 * ```
 */
export function decryptMessage(payload, keys, options = {}) {
  assertSecurePayloadShape(payload);
  assertKeys(keys);
  const meta = validateMetadata(metadataOf(payload));

  // Session/key/device binding checks (defence against a misrouted payload).
  if (options.expectedSessionId && String(options.expectedSessionId) !== meta.sessionId) {
    throw new SessionMismatchError("Payload sessionId does not match the session");
  }
  if (options.expectedKeyId && String(options.expectedKeyId) !== meta.keyId) {
    throw new SessionMismatchError("Payload keyId does not match the session key");
  }
  if (meta.keyId !== keys.keyId) {
    throw new SessionMismatchError("Payload was encrypted under a different key generation");
  }
  if (options.expectedReceiverDevice && meta.receiverDevice && String(options.expectedReceiverDevice) !== meta.receiverDevice) {
    throw new SessionMismatchError("Payload is addressed to a different device");
  }

  const { iv, ciphertext, tag, mac } = decodeSecurePayload(payload);
  const aad = canonicalAAD(meta);

  const plaintext = open({ encryptionKey: keys.encryptionKey, macKey: keys.macKey, iv, ciphertext, tag, mac, aad });
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw new MalformedPayloadError("Decrypted plaintext is not valid JSON", { cause: error });
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Non-throwing decrypt: returns `{ ok, message }` or `{ ok:false, reason, error }`.
 * @param {object} payload @param {object} keys @param {object} [options]
 */
export function tryDecryptMessage(payload, keys, options = {}) {
  try {
    return { ok: true, message: decryptMessage(payload, keys, options) };
  } catch (error) {
    return { ok: false, reason: error.code ?? "ERR_TRANSPORT", error };
  }
}

export { IntegrityError };

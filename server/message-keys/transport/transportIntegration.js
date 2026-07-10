/**
 * @module message-keys/transport
 *
 * **Secure Transport integration** for per-message keys — the complete Sprint 5 pipeline.
 *
 * ```
 * encrypt: message ─▶ resolve session ─▶ resolve sending chain ─▶ derive MKₙ ─▶ encrypt ─▶ DESTROY MKₙ ─▶ advance chain ─▶ send
 * decrypt: receive ─▶ resolve receiving chain ─▶ derive MKₙ ─▶ decrypt ─▶ DESTROY MKₙ ─▶ advance chain
 * ```
 *
 * The message key never leaves the {@link MessageKeyManager}; this module supplies the
 * `sealFn`/`openFn` that call the Layer 4 Secure Transport AEAD with the ephemeral key.
 *
 * ## Envelope
 * Because the receiver must know which chain index produced a message BEFORE it can derive
 * the key, encryption wraps the Layer 4 `SecurePayload` in a small envelope carrying the
 * PUBLIC `{ messageNumber, generation }`. These are not secret; if tampered, the receiver
 * derives the wrong key and decryption fails closed (the AEAD tag / HMAC rejects it).
 *
 * @security No keys pass through this module. The per-message key is derived, used, and
 * wiped entirely inside the manager's `sealMessage`/`openMessage`.
 */

import { encryptMessage as secureEncrypt } from "../../secure-transport/encryptor/encryptor.js";
import { decryptMessage as secureDecrypt } from "../../secure-transport/decryptor/decryptor.js";
import { MK_ENVELOPE_VERSION } from "../types/types.js";
import { validateEnvelope } from "../validators/validators.js";

/**
 * Encrypt a message with a unique per-message key. Returns a message envelope containing the
 * ciphertext `SecurePayload` + the public `{ messageNumber, generation }`.
 * @param {object} message the plaintext application message
 * @param {object} context `{ sessionId, senderDevice?, receiverDevice?, type?, protocolVersion?, clock? }`
 * @param {{ messageKeyManager: import("../manager/messageKeyManager.js").MessageKeyManager }} deps
 * @returns {Promise<object>} the message envelope
 */
export async function encryptMessage(message, context, deps) {
  const { result } = await deps.messageKeyManager.sealMessage(context.sessionId, (keys, meta) => {
    const payload = secureEncrypt(message, keys, context);
    return {
      v: MK_ENVELOPE_VERSION,
      sessionId: String(context.sessionId),
      messageNumber: meta.messageNumber,
      generation: meta.generation,
      direction: keys.direction,
      payload,
    };
  });
  return result;
}

/**
 * Decrypt a message envelope, deriving the matching per-message key from the receiving chain.
 * @param {object} envelope the message envelope produced by {@link encryptMessage}
 * @param {object} context `{ sessionId? }`
 * @param {{ messageKeyManager: import("../manager/messageKeyManager.js").MessageKeyManager }} deps
 * @param {object} [options] passed to the Secure Transport decryptor (e.g. expectedReceiverDevice)
 * @returns {Promise<object>} the decrypted application message
 */
export async function decryptMessage(envelope, context, deps, options = {}) {
  validateEnvelope(envelope);
  const sessionId = context.sessionId ?? envelope.sessionId;
  const { result } = await deps.messageKeyManager.openMessage(
    sessionId,
    { messageNumber: envelope.messageNumber, generation: envelope.generation },
    (keys) => secureDecrypt(envelope.payload, keys, options),
  );
  return result;
}

/**
 * Build a reusable per-message transport bound to a {@link MessageKeyManager}.
 * @param {{ messageKeyManager: object }} deps @returns {{ encrypt: Function, decrypt: Function, perMessageKeys: boolean }}
 */
export function createMessageKeyTransport(deps) {
  return {
    encrypt: (message, context) => encryptMessage(message, context, deps),
    decrypt: (envelope, context, options) => decryptMessage(envelope, context ?? {}, deps, options),
    perMessageKeys: true,
  };
}

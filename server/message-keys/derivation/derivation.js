/**
 * @module message-keys/derivation
 *
 * Deterministic **per-message key derivation** from a chain key. Given the chain key `CKₙ`
 * for a `(direction, generation, messageNumber)`, derive an independent message key bundle:
 *
 * ```
 * encryptionKey = HKDF(CKₙ, salt, "msg-enc|dir|gen|n")
 * macKey        = HKDF(CKₙ, salt, "msg-mac|dir|gen|n")
 * ```
 *
 * @security The message key is a fresh HKDF output — cryptographically independent of the
 * `chain-advance` output the ratchet consumes, so leaking a message key reveals nothing
 * about the chain or other messages. The `direction` used here is the **canonical chain
 * direction** (`i2r`/`r2i`), NOT a device-relative send/recv label, so a sender and receiver
 * derive an IDENTICAL key for the same message (the sender's sending chain == the receiver's
 * receiving chain). No key is transmitted.
 *
 * @important Message keys are EPHEMERAL — derive, use once, then {@link module:message-keys/destruction}
 * wipes them. The same message key is never reused.
 */

import crypto from "node:crypto";
import { MK_NAMESPACE, MK_VERSION, MK_KEY_BYTES } from "../types/types.js";
import { MessageKeyDerivationError } from "../errors.js";

/** HKDF-SHA256 into `length` bytes. */
function hkdf(secret, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, length));
}

/** Per-session salt binding message keys to the session/handshake. */
export function messageSalt(context) {
  return Buffer.from(`${MK_NAMESPACE}-salt|v${MK_VERSION}|sid=${context.sessionId}|hs=${context.handshakeId ?? ""}`, "utf8");
}

/** An HKDF `info` label for a message-key purpose at a position. */
function label(purpose, direction, generation, messageNumber) {
  return Buffer.from(`${MK_NAMESPACE}|v${MK_VERSION}|${purpose}|dir=${direction}|gen=${generation}|n=${messageNumber}`, "utf8");
}

/**
 * Derive the message key bundle for one message.
 * @param {Buffer} chainKey the chain key `CKₙ` at the message's index
 * @param {object} params
 * @param {string} params.direction canonical chain direction (`i2r`/`r2i`)
 * @param {number} params.generation @param {number} params.messageNumber
 * @param {{ sessionId: string, handshakeId?: string }} params.context
 * @returns {import("../types/types.js").MessageKeyBundle} EPHEMERAL device-local key material
 * @throws {MessageKeyDerivationError}
 */
export function deriveMessageKey(chainKey, params) {
  if (!Buffer.isBuffer(chainKey) || chainKey.length === 0) {
    throw new MessageKeyDerivationError("A chain key is required to derive a message key");
  }
  const { direction, generation, messageNumber, context } = params;
  try {
    const salt = messageSalt(context);
    const encryptionKey = hkdf(chainKey, salt, label("msg-enc", direction, generation, messageNumber), MK_KEY_BYTES);
    const macKey = hkdf(chainKey, salt, label("msg-mac", direction, generation, messageNumber), MK_KEY_BYTES);
    const fingerprint = crypto.createHash("sha256").update(encryptionKey).update(macKey).digest("hex");
    const keyId = crypto
      .createHash("sha256")
      .update(`${MK_NAMESPACE}|id|${direction}|${generation}|${messageNumber}`)
      .update(encryptionKey)
      .digest("hex")
      .slice(0, 32);
    return { encryptionKey, macKey, keyId, keyFingerprint: fingerprint, messageNumber, direction, generation };
  } catch (error) {
    throw new MessageKeyDerivationError("Failed to derive the message key", { cause: error, details: { messageNumber } });
  }
}

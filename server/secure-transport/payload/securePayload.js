/**
 * @module secure-transport/payload
 *
 * The **Secure Payload** model — the encrypted envelope that travels over any
 * transport and is persisted by the relay. It carries ciphertext + integrity data +
 * PUBLIC metadata, and **never any plaintext**.
 *
 * ```
 * SecurePayload {
 *   v, payloadVersion, type, protocolVersion,          // versions + message type
 *   sessionId, keyId, senderDevice, receiverDevice,    // session/device binding (metadata)
 *   timestamp, nonce,                                   // + replay metadata
 *   encryption: { algorithm, iv, ciphertext, tag },     // AES-256-GCM (base64)
 *   integrity:  { algorithm, mac },                     // encrypt-then-HMAC (base64)
 *   ratchet: null                                       // reserved for Layer 5
 * }
 * ```
 */

import { CIPHER_ALGORITHM, MAC_ALGORITHM } from "../types.js";
import { MalformedPayloadError } from "../errors.js";
import { validateMetadata } from "../metadata/metadata.js";

const b64 = (buf) => (Buffer.isBuffer(buf) ? buf.toString("base64") : buf);
const unb64 = (s) => Buffer.from(String(s), "base64");

/**
 * Assemble a {@link SecurePayload} from metadata + AEAD output.
 * @param {object} meta the metadata block (from `buildMetadata`)
 * @param {{ iv: Buffer, ciphertext: Buffer, tag: Buffer, mac: Buffer }} sealed
 * @returns {import("../types.js").SecurePayload}
 */
export function assembleSecurePayload(meta, sealed) {
  return {
    ...meta,
    encryption: {
      algorithm: CIPHER_ALGORITHM,
      iv: b64(sealed.iv),
      ciphertext: b64(sealed.ciphertext),
      tag: b64(sealed.tag),
    },
    integrity: {
      algorithm: MAC_ALGORITHM,
      mac: b64(sealed.mac),
    },
    ratchet: null, // Layer 5 forward-secrecy metadata slot
  };
}

/**
 * Decode a {@link SecurePayload}'s binary fields into Buffers for decryption.
 * @param {object} payload @returns {{ iv: Buffer, ciphertext: Buffer, tag: Buffer, mac: Buffer }}
 * @throws {MalformedPayloadError}
 */
export function decodeSecurePayload(payload) {
  if (!payload?.encryption || !payload?.integrity) {
    throw new MalformedPayloadError("Payload missing encryption/integrity block");
  }
  try {
    return {
      iv: unb64(payload.encryption.iv),
      ciphertext: unb64(payload.encryption.ciphertext),
      tag: unb64(payload.encryption.tag),
      mac: unb64(payload.integrity.mac),
    };
  } catch (error) {
    throw new MalformedPayloadError("Payload has undecodable binary fields", { cause: error });
  }
}

/** The metadata subset of a payload (top-level fields, excluding encryption/integrity). */
export function metadataOf(payload) {
  const { encryption, integrity, ratchet, ...meta } = payload;
  return meta;
}

/**
 * Whether an object looks like a SecurePayload (shape check; not integrity).
 * @param {any} obj @returns {boolean}
 */
export function isSecurePayload(obj) {
  return !!(
    obj &&
    typeof obj === "object" &&
    typeof obj.v === "number" &&
    obj.encryption &&
    typeof obj.encryption.ciphertext === "string" &&
    obj.integrity &&
    typeof obj.integrity.mac === "string" &&
    // A secure payload must NOT carry plaintext.
    obj.text === undefined &&
    obj.plaintext === undefined
  );
}

/**
 * Assert a payload is structurally a valid SecurePayload (shape + metadata + no
 * plaintext). Does NOT verify integrity (that needs keys).
 * @param {object} payload @throws {MalformedPayloadError}
 */
export function assertSecurePayloadShape(payload) {
  if (!isSecurePayload(payload)) {
    throw new MalformedPayloadError("Not a valid secure payload (or contains plaintext)");
  }
  validateMetadata(metadataOf(payload));
  for (const f of ["iv", "ciphertext", "tag"]) {
    if (typeof payload.encryption[f] !== "string" || !payload.encryption[f]) {
      throw new MalformedPayloadError(`encryption.${f} missing`, { details: { field: f } });
    }
  }
  return payload;
}

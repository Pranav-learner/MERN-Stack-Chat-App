/**
 * @module trust/qr
 *
 * QR verification **infrastructure** — the payload format only. It builds,
 * serializes, deserializes, and validates the data a QR code would carry so one
 * user can verify another's identity by scanning. It does NOT render images or do
 * camera scanning (out of scope); a future UI encodes `serialize()`'s string into
 * a QR and decodes a scanned string back through `deserialize()`.
 *
 * ## Payload
 * A self-describing, integrity-checked envelope carrying the subject's PUBLIC
 * identity: `{ v, type, subjectUserId, identityId, publicKey, algorithm,
 * fingerprint, issuedAt, checksum }`. The `checksum` (SHA-256 over the canonical
 * body) plus the fingerprint↔key consistency check make tampering detectable.
 *
 * @security Contains only PUBLIC identity material. The QR does not prove
 * possession of the private key; it conveys "this is my identity key" for
 * out-of-band comparison. It is NOT a handshake.
 */

import crypto from "node:crypto";
import { InvalidQrPayloadError } from "../errors.js";
import { decodePublicKey } from "../../identity/validators/identityValidators.js";
import { verifyFingerprint } from "../fingerprints/fingerprint.js";

/** QR payload format version. */
export const QR_PAYLOAD_VERSION = 1;
/** Fixed type tag. */
export const QR_PAYLOAD_TYPE = "securechat-identity-verification";

/** Deterministic checksum over the canonical payload body. */
function checksum(body) {
  const canonical = JSON.stringify({
    v: body.v,
    type: body.type,
    subjectUserId: body.subjectUserId,
    identityId: body.identityId,
    publicKey: body.publicKey,
    algorithm: body.algorithm,
    fingerprint: body.fingerprint,
    issuedAt: body.issuedAt,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build a QR verification payload object for a subject identity.
 * @param {{ subjectUserId: string, identityId: string, publicKey: string,
 *           algorithm: string, fingerprint: string, issuedAt?: string }} input
 * @returns {object} the payload object (see module docs)
 */
export function buildQrPayload(input) {
  const body = {
    v: QR_PAYLOAD_VERSION,
    type: QR_PAYLOAD_TYPE,
    subjectUserId: String(input.subjectUserId),
    identityId: input.identityId,
    publicKey: input.publicKey,
    algorithm: input.algorithm,
    fingerprint: input.fingerprint,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return { ...body, checksum: checksum(body) };
}

/**
 * Serialize a payload to the compact string a QR code would encode (base64url of
 * the JSON).
 * @param {object} payload
 * @returns {string}
 */
export function serializeQrPayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Deserialize + fully validate a scanned QR string.
 * @param {string} serialized the scanned QR string
 * @returns {object} the validated payload
 * @throws {InvalidQrPayloadError} on malformed, unsupported, or tampered payloads
 * @example
 * const payload = deserializeQrPayload(scannedString);
 * // payload.publicKey / payload.fingerprint are safe to use for verification
 */
export function deserializeQrPayload(serialized) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(serialized), "base64url").toString("utf8"));
  } catch (cause) {
    throw new InvalidQrPayloadError("QR payload is not valid base64url JSON", { cause });
  }
  validateQrPayload(payload);
  return payload;
}

/**
 * Validate a QR payload object (type, version, checksum, fingerprint↔key).
 * @param {object} payload
 * @throws {InvalidQrPayloadError}
 */
export function validateQrPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new InvalidQrPayloadError("QR payload must be an object");
  }
  if (payload.type !== QR_PAYLOAD_TYPE) {
    throw new InvalidQrPayloadError("Unrecognized QR payload type");
  }
  if (payload.v !== QR_PAYLOAD_VERSION) {
    throw new InvalidQrPayloadError(`Unsupported QR payload version ${payload.v}`);
  }
  for (const field of ["subjectUserId", "identityId", "publicKey", "algorithm", "fingerprint", "issuedAt", "checksum"]) {
    if (typeof payload[field] !== "string" || payload[field].length === 0) {
      throw new InvalidQrPayloadError(`QR payload missing field: ${field}`);
    }
  }
  // Integrity: recompute the checksum.
  if (checksum(payload) !== payload.checksum) {
    throw new InvalidQrPayloadError("QR payload checksum mismatch (tampered)");
  }
  // Consistency: fingerprint must match the embedded public key.
  let bytes;
  try {
    bytes = decodePublicKey(payload.publicKey);
  } catch (cause) {
    throw new InvalidQrPayloadError("QR payload public key is invalid", { cause });
  }
  if (!verifyFingerprint(bytes, payload.fingerprint)) {
    throw new InvalidQrPayloadError("QR payload fingerprint does not match its public key");
  }
}

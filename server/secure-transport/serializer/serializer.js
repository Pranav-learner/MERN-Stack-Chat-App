/**
 * @module secure-transport/serializer
 *
 * Serialization for {@link SecurePayload}s. Two interchangeable encodings:
 *
 * - **JSON** — the canonical form persisted by the relay + sent over REST/WebSocket.
 * - **compact** — the JSON, base64url-wrapped (URL / header / QR safe).
 *
 * The payload's binary fields are already base64 inside the object, so JSON is
 * transport-safe as-is.
 *
 * @security Serialization moves ciphertext only. A parsed payload is shape-checked
 * (never integrity-checked without keys). Size is bounded to reject oversized frames.
 */

import { assertSecurePayloadShape } from "../payload/securePayload.js";
import { MalformedPayloadError } from "../errors.js";

/** Maximum serialized secure-payload size (bytes). */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB (accommodates image data URLs)

/** Serialize a secure payload to canonical JSON. @throws {MalformedPayloadError} */
export function serialize(payload) {
  assertSecurePayloadShape(payload);
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new MalformedPayloadError("Secure payload exceeds maximum size", { details: { max: MAX_PAYLOAD_BYTES } });
  }
  return json;
}

/** Parse a secure payload from JSON (shape-checked, not integrity-checked). */
export function deserialize(text) {
  if (typeof text !== "string") {
    if (text && typeof text === "object") return assertSecurePayloadShape(text); // already an object
    throw new MalformedPayloadError("Serialized payload must be a string or object");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new MalformedPayloadError("Serialized payload exceeds maximum size");
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (error) {
    throw new MalformedPayloadError("Malformed JSON secure payload", { cause: error });
  }
  return assertSecurePayloadShape(obj);
}

/** Serialize to a compact base64url string. */
export function serializeCompact(payload) {
  return Buffer.from(serialize(payload), "utf8").toString("base64url");
}

/** Parse a compact base64url string back into a payload. */
export function deserializeCompact(text) {
  let json;
  try {
    json = Buffer.from(String(text), "base64url").toString("utf8");
  } catch (error) {
    throw new MalformedPayloadError("Malformed compact secure payload", { cause: error });
  }
  return deserialize(json);
}

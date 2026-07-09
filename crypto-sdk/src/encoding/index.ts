/**
 * @module encoding
 *
 * Deterministic, validated conversions between binary data ({@link Uint8Array})
 * and textual representations (UTF-8, hex, base64, base64url).
 *
 * All functions:
 * - Accept/return {@link Uint8Array} for binary (never Node `Buffer` in the public
 *   type, though `Buffer` instances are accepted since `Buffer extends Uint8Array`).
 * - Validate their input and throw {@link EncodingError} on malformed data rather
 *   than silently producing garbage (unlike raw `Buffer.from`).
 *
 * These helpers do NOT perform cryptography; they are the serialization boundary
 * used by keys, signatures, and encrypted payloads.
 */

import { EncodingError } from "../errors/index.js";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const HEX_RE = /^[0-9a-fA-F]*$/;

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new EncodingError(`Expected a string for ${label}, received ${typeof value}`);
  }
}

function assertBytes(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new EncodingError(`Expected a Uint8Array for ${label}, received ${typeof value}`);
  }
}

/**
 * Encode a UTF-8 string to bytes.
 *
 * @example
 * ```ts
 * utf8ToBytes("héllo"); // Uint8Array(6) [104, 195, 169, 108, 108, 111]
 * ```
 * @throws {EncodingError} if `str` is not a string.
 */
export function utf8ToBytes(str: string): Uint8Array {
  assertString(str, "utf8ToBytes");
  return new Uint8Array(Buffer.from(str, "utf8"));
}

/**
 * Decode bytes as a UTF-8 string.
 *
 * @throws {EncodingError} if `bytes` is not a Uint8Array.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  assertBytes(bytes, "bytesToUtf8");
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Encode bytes as standard (RFC 4648 §4) base64, with padding.
 * @throws {EncodingError} if `bytes` is not a Uint8Array.
 */
export function toBase64(bytes: Uint8Array): string {
  assertBytes(bytes, "toBase64");
  return Buffer.from(bytes).toString("base64");
}

/**
 * Decode standard base64 to bytes. Rejects strings containing characters outside
 * the base64 alphabet (a plain `Buffer.from` would silently drop them).
 * @throws {EncodingError} if `str` is not valid base64.
 */
export function fromBase64(str: string): Uint8Array {
  assertString(str, "fromBase64");
  if (!BASE64_RE.test(str)) {
    throw new EncodingError("Malformed base64 string");
  }
  return new Uint8Array(Buffer.from(str, "base64"));
}

/**
 * Encode bytes as URL-safe base64 (RFC 4648 §5), WITHOUT padding.
 * Suitable for JSON envelopes, URLs, and JWK fields.
 * @throws {EncodingError} if `bytes` is not a Uint8Array.
 */
export function toBase64Url(bytes: Uint8Array): string {
  assertBytes(bytes, "toBase64Url");
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decode URL-safe base64 (padding optional) to bytes.
 * @throws {EncodingError} if `str` is not valid base64url.
 */
export function fromBase64Url(str: string): Uint8Array {
  assertString(str, "fromBase64Url");
  // Node's 'base64url' decoder tolerates padding; strip it for validation.
  const stripped = str.replace(/=+$/, "");
  if (!BASE64URL_RE.test(stripped)) {
    throw new EncodingError("Malformed base64url string");
  }
  return new Uint8Array(Buffer.from(str, "base64url"));
}

/**
 * Encode bytes as lowercase hexadecimal.
 * @throws {EncodingError} if `bytes` is not a Uint8Array.
 */
export function toHex(bytes: Uint8Array): string {
  assertBytes(bytes, "toHex");
  return Buffer.from(bytes).toString("hex");
}

/**
 * Decode a hex string to bytes. Requires an even length and only hex digits.
 * @throws {EncodingError} if `str` is not valid hex.
 */
export function fromHex(str: string): Uint8Array {
  assertString(str, "fromHex");
  if (str.length % 2 !== 0 || !HEX_RE.test(str)) {
    throw new EncodingError("Malformed hex string (must be even length, hex digits only)");
  }
  return new Uint8Array(Buffer.from(str, "hex"));
}

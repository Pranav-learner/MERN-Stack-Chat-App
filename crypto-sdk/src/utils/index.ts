/**
 * @module utils
 *
 * Security-adjacent helpers used across the SDK: input validation, constant-time
 * comparison, best-effort memory wiping, and byte coercion.
 *
 * These are deliberately small and dependency-light. They do not implement
 * cryptography themselves (except `constantTimeEqual`, which delegates to Node's
 * audited `timingSafeEqual`).
 */

import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "../errors/index.js";
import { utf8ToBytes } from "../encoding/index.js";

/** Narrow an unknown value to `Uint8Array` (Node `Buffer` counts, being a subclass). */
export function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Assert that `value` is a `Uint8Array`, otherwise throw {@link ValidationError}.
 * @throws {ValidationError}
 */
export function assertUint8Array(value: unknown, label = "value"): asserts value is Uint8Array {
  if (!isUint8Array(value)) {
    throw new ValidationError(`${label} must be a Uint8Array, received ${typeof value}`);
  }
}

/**
 * Assert that `bytes` has exactly `expected` length.
 * @throws {ValidationError}
 */
export function assertLength(bytes: Uint8Array, expected: number, label = "value"): void {
  assertUint8Array(bytes, label);
  if (bytes.length !== expected) {
    throw new ValidationError(`${label} must be ${expected} bytes, received ${bytes.length}`);
  }
}

/**
 * Assert that `bytes` is non-empty.
 * @throws {ValidationError}
 */
export function assertNonEmpty(bytes: Uint8Array, label = "value"): void {
  assertUint8Array(bytes, label);
  if (bytes.length === 0) {
    throw new ValidationError(`${label} must not be empty`);
  }
}

/**
 * Assert that `n` is a safe, non-negative integer (optionally within `[min, max]`).
 * @throws {ValidationError}
 */
export function assertInteger(
  n: unknown,
  label = "value",
  bounds: { min?: number; max?: number } = {},
): asserts n is number {
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new ValidationError(`${label} must be a safe integer, received ${String(n)}`);
  }
  if (bounds.min !== undefined && n < bounds.min) {
    throw new ValidationError(`${label} must be >= ${bounds.min}, received ${n}`);
  }
  if (bounds.max !== undefined && n > bounds.max) {
    throw new ValidationError(`${label} must be <= ${bounds.max}, received ${n}`);
  }
}

/**
 * Coerce a `Uint8Array | string` into bytes. Strings are interpreted as UTF-8.
 *
 * This is the single normalization point used by hashing, symmetric encryption,
 * and signatures so callers may pass either raw bytes or human text.
 *
 * @throws {ValidationError} if `input` is neither a string nor a Uint8Array.
 */
export function coerceToBytes(input: Uint8Array | string, label = "input"): Uint8Array {
  if (typeof input === "string") {
    return utf8ToBytes(input);
  }
  if (isUint8Array(input)) {
    return input;
  }
  throw new ValidationError(`${label} must be a Uint8Array or string, received ${typeof input}`);
}

/**
 * Constant-time equality check for two byte arrays.
 *
 * Uses Node's `timingSafeEqual` (OpenSSL-backed) to avoid leaking, via timing,
 * *where* two secrets first differ. Returns `false` for length mismatches; note
 * that the length itself is not hidden (standard and accepted behaviour).
 *
 * @example
 * ```ts
 * if (!constantTimeEqual(receivedTag, expectedTag)) throw new Error("bad tag");
 * ```
 * @throws {ValidationError} if either argument is not a Uint8Array.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  assertUint8Array(a, "a");
  assertUint8Array(b, "b");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Best-effort, in-place zeroing of sensitive bytes.
 *
 * CAVEAT: In a managed runtime like V8 there is NO guarantee the underlying
 * memory is not copied by the GC beforehand; this reduces, but does not
 * eliminate, the window in which secrets sit in memory. It is a hygiene measure,
 * not a security guarantee. Only wipe buffers you own and will not reuse.
 */
export function wipe(bytes: Uint8Array): void {
  assertUint8Array(bytes, "bytes");
  bytes.fill(0);
}

/**
 * Return a defensive copy of `bytes`, so callers cannot mutate internal state and
 * internal state cannot mutate callers' buffers.
 */
export function cloneBytes(bytes: Uint8Array): Uint8Array {
  assertUint8Array(bytes, "bytes");
  return bytes.slice();
}

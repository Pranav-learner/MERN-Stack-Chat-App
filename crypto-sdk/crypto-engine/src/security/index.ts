/**
 * @module security
 *
 * Expanded security utilities layered on Sprint 1's `utils`. Provides a
 * disposable {@link SecureBuffer}, randomness sanity validation, binary/input
 * validation, and re-exports the SDK's constant-time comparison and wipe.
 *
 * NOTE: memory wiping in a managed runtime (V8) is best-effort — the GC may have
 * copied secrets beforehand. These are hygiene measures, not guarantees.
 */

import {
  cloneBytes,
  constantTimeEqual,
  isUint8Array,
  wipe,
  ValidationError,
} from "@securechat/crypto-sdk";

export { constantTimeEqual, wipe, cloneBytes, isUint8Array };

/**
 * A holder for sensitive bytes that can be explicitly wiped, and auto-wipes when
 * used with the `using` declaration (implements `Symbol.dispose`).
 *
 * @example
 * ```ts
 * {
 *   using secret = new SecureBuffer(derivedKeyBytes);
 *   doWork(secret.bytes);
 * } // secret.wipe() runs automatically here
 * ```
 */
export class SecureBuffer implements Disposable {
  private readonly _bytes: Uint8Array;
  private _wiped = false;

  constructor(bytes: Uint8Array) {
    if (!isUint8Array(bytes)) throw new ValidationError("SecureBuffer requires a Uint8Array");
    // Copy so the caller's buffer and ours are independent.
    this._bytes = cloneBytes(bytes);
  }

  /** Allocate a zeroed secure buffer of `length` bytes. */
  static alloc(length: number): SecureBuffer {
    if (!Number.isInteger(length) || length < 0) {
      throw new ValidationError("length must be a non-negative integer");
    }
    return new SecureBuffer(new Uint8Array(length));
  }

  /** A defensive copy of the held bytes. @throws {ValidationError} if wiped. */
  get bytes(): Uint8Array {
    if (this._wiped) throw new ValidationError("SecureBuffer has been wiped");
    return cloneBytes(this._bytes);
  }

  /** Byte length. */
  get length(): number {
    return this._bytes.length;
  }

  /** Whether this buffer has been wiped. */
  get isWiped(): boolean {
    return this._wiped;
  }

  /** Zero the underlying bytes (best-effort). Idempotent. */
  wipe(): void {
    wipe(this._bytes);
    this._wiped = true;
  }

  [Symbol.dispose](): void {
    this.wipe();
  }

  /** Avoid leaking secret bytes via logs / JSON. */
  toJSON(): string {
    return "[SecureBuffer]";
  }
}

/** Coerce assorted binary inputs to a `Uint8Array`. @throws {ValidationError} */
export function toBytes(input: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new ValidationError("Expected binary input (Uint8Array/ArrayBuffer/TypedArray)");
}

/** Assert a value is binary of an optional maximum length. @throws {ValidationError} */
export function assertBinary(
  value: unknown,
  maxLength?: number,
  label = "value",
): asserts value is Uint8Array {
  if (!isUint8Array(value)) {
    throw new ValidationError(`${label} must be a Uint8Array`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ValidationError(`${label} exceeds maximum length ${maxLength} (got ${value.length})`);
  }
}

/** Report of a randomness sanity check. */
export interface RandomnessReport {
  ok: boolean;
  length: number;
  uniqueBytes: number;
  /** Estimated Shannon entropy in bits per byte (0–8). */
  entropyBitsPerByte: number;
  reason?: string;
}

/**
 * A *sanity* check on candidate random data. This is NOT a statistical randomness
 * certifier — it only catches gross failures (empty, too short, all-identical
 * bytes, or implausibly low entropy). Use it to guard against obviously broken
 * inputs, never as proof of cryptographic randomness.
 *
 * @param bytes the data to inspect.
 * @param minLength minimum acceptable length (default 16).
 */
export function analyzeRandomness(bytes: Uint8Array, minLength = 16): RandomnessReport {
  assertBinary(bytes, undefined, "bytes");
  const length = bytes.length;
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b]!++;
  let uniqueBytes = 0;
  let entropy = 0;
  for (const c of counts) {
    if (c > 0) {
      uniqueBytes++;
      const p = c / length;
      entropy -= p * Math.log2(p);
    }
  }
  let ok = true;
  let reason: string | undefined;
  if (length < minLength) {
    ok = false;
    reason = `too short (${length} < ${minLength})`;
  } else if (uniqueBytes <= 1) {
    ok = false;
    reason = "all bytes identical";
  } else if (length >= 128 && entropy < 6) {
    ok = false;
    reason = `low entropy (${entropy.toFixed(2)} bits/byte)`;
  }
  const report: RandomnessReport = { ok, length, uniqueBytes, entropyBitsPerByte: entropy };
  if (reason) report.reason = reason;
  return report;
}

/**
 * Throwing variant of {@link analyzeRandomness}.
 * @throws {ValidationError} if the data fails the sanity check.
 */
export function assertRandomness(bytes: Uint8Array, minLength = 16): void {
  const report = analyzeRandomness(bytes, minLength);
  if (!report.ok) {
    throw new ValidationError(`Randomness sanity check failed: ${report.reason}`);
  }
}

/**
 * {@link SymmetricKey} — an opaque wrapper around 32 bytes of AES-256 key
 * material. Knows nothing about chat, sessions, or messages.
 */

import { AES_256_GCM_KEY_BYTES, SymmetricAlgorithm } from "../constants/index.js";
import { InvalidKeyError } from "../errors/index.js";
import { fromBase64, fromHex, toBase64, toHex } from "../encoding/index.js";
import { assertLength, cloneBytes, wipe } from "../utils/index.js";
import { randomBytes } from "../random/index.js";

/**
 * A 256-bit symmetric key for AES-256-GCM.
 *
 * The raw bytes are held privately; `.bytes` always returns a defensive copy so
 * the internal buffer cannot be mutated by callers. Construct via the static
 * factories — the constructor is private to force validation.
 *
 * @example
 * ```ts
 * const key = SymmetricKey.generate();
 * const stored = key.toBase64();               // persist / transmit (as appropriate)
 * const restored = SymmetricKey.fromBase64(stored);
 * ```
 */
export class SymmetricKey {
  /** The AEAD algorithm this key is intended for. */
  public readonly algorithm = SymmetricAlgorithm.AES_256_GCM;

  private readonly _bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    assertLength(bytes, AES_256_GCM_KEY_BYTES, "symmetric key");
    // Copy so external mutation of the source cannot alter this key.
    this._bytes = cloneBytes(bytes);
  }

  /** Generate a fresh random 256-bit key from the CSPRNG. */
  static generate(): SymmetricKey {
    return new SymmetricKey(randomBytes(AES_256_GCM_KEY_BYTES));
  }

  /**
   * Wrap existing 32-byte key material.
   * @throws {InvalidKeyError} if not exactly 32 bytes.
   */
  static fromBytes(bytes: Uint8Array): SymmetricKey {
    try {
      return new SymmetricKey(bytes);
    } catch (cause) {
      throw new InvalidKeyError("Symmetric key must be exactly 32 bytes", { cause });
    }
  }

  /** Import a key from a base64 string. @throws {InvalidKeyError} */
  static fromBase64(b64: string): SymmetricKey {
    return SymmetricKey.fromBytes(fromBase64(b64));
  }

  /** Import a key from a hex string. @throws {InvalidKeyError} */
  static fromHex(hex: string): SymmetricKey {
    return SymmetricKey.fromBytes(fromHex(hex));
  }

  /** Raw key bytes (defensive copy). */
  get bytes(): Uint8Array {
    return cloneBytes(this._bytes);
  }

  /** Key length in bytes (always 32). */
  get length(): number {
    return this._bytes.length;
  }

  /** Export as base64. */
  toBase64(): string {
    return toBase64(this._bytes);
  }

  /** Export as hex. */
  toHex(): string {
    return toHex(this._bytes);
  }

  /**
   * Best-effort zeroing of the internal key material. After calling this the key
   * must not be used again. See caveats on {@link wipe}.
   */
  destroy(): void {
    wipe(this._bytes);
  }

  /** Avoid accidental secret leakage in logs / `JSON.stringify`. */
  toJSON(): string {
    return "[SymmetricKey]";
  }
}

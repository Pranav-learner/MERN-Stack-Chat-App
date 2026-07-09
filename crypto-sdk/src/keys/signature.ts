/**
 * {@link Signature} — an opaque wrapper around raw signature bytes (64 bytes for
 * Ed25519), with encoding helpers. It carries no notion of what was signed.
 */

import { ED25519_SIGNATURE_BYTES } from "../constants/index.js";
import { InvalidSignatureError } from "../errors/index.js";
import { fromBase64, fromHex, toBase64, toHex } from "../encoding/index.js";
import { cloneBytes, assertNonEmpty } from "../utils/index.js";

/**
 * A digital signature value.
 *
 * @example
 * ```ts
 * const sig = sign(privateKey, "message");
 * const wire = sig.toBase64();
 * const parsed = Signature.fromBase64(wire);
 * ```
 */
export class Signature {
  private readonly _bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    assertNonEmpty(bytes, "signature");
    this._bytes = cloneBytes(bytes);
  }

  /** Wrap raw signature bytes. @throws {InvalidSignatureError} if empty. */
  static fromBytes(bytes: Uint8Array): Signature {
    try {
      return new Signature(bytes);
    } catch (cause) {
      throw new InvalidSignatureError("Signature bytes are invalid", { cause });
    }
  }

  /** Import from base64. */
  static fromBase64(b64: string): Signature {
    return Signature.fromBytes(fromBase64(b64));
  }

  /** Import from hex. */
  static fromHex(hex: string): Signature {
    return Signature.fromBytes(fromHex(hex));
  }

  /** Raw signature bytes (defensive copy). */
  get bytes(): Uint8Array {
    return cloneBytes(this._bytes);
  }

  /** Signature length in bytes (64 for Ed25519). */
  get length(): number {
    return this._bytes.length;
  }

  /**
   * Whether this signature has the canonical Ed25519 length (64 bytes). A `false`
   * result guarantees verification will fail; a `true` result does not by itself
   * imply validity.
   */
  get isEd25519Length(): boolean {
    return this._bytes.length === ED25519_SIGNATURE_BYTES;
  }

  /** Export as base64. */
  toBase64(): string {
    return toBase64(this._bytes);
  }

  /** Export as hex. */
  toHex(): string {
    return toHex(this._bytes);
  }
}

/**
 * {@link SharedSecret} — the raw output of a Diffie–Hellman key agreement.
 *
 * A raw ECDH output MUST NOT be used directly as an encryption key: its bytes are
 * not uniformly random and it carries no context binding. This class therefore
 * only exposes derivation via HKDF ({@link deriveKey} / {@link deriveBytes}), which
 * is the correct bridge from "shared secret" to "usable session/message key" that
 * future modules will build on.
 */

import { HashAlgorithm } from "../constants/index.js";
import { hkdf } from "../kdf/index.js";
import { cloneBytes, wipe, assertNonEmpty } from "../utils/index.js";
import { SymmetricKey } from "./symmetric-key.js";

/** Options for {@link SharedSecret.deriveKey} / {@link SharedSecret.deriveBytes}. */
export interface DeriveOptions {
  /** HKDF salt (random per context recommended). */
  salt?: Uint8Array | string;
  /** HKDF context/info label, e.g. `"securechat:session:v1"`. */
  info?: Uint8Array | string;
  /** Output length in bytes (default 32). */
  length?: number;
  /** Underlying hash (default SHA-256). */
  hash?: HashAlgorithm;
}

/**
 * Wraps raw shared-secret bytes and derives keys from them via HKDF.
 */
export class SharedSecret {
  private readonly _bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    assertNonEmpty(bytes, "shared secret");
    this._bytes = cloneBytes(bytes);
  }

  /** Wrap raw agreement output (e.g. from X25519). */
  static fromBytes(bytes: Uint8Array): SharedSecret {
    return new SharedSecret(bytes);
  }

  /**
   * Raw secret bytes (defensive copy).
   * Prefer {@link deriveKey}; only touch raw bytes for interop with another KDF.
   */
  get bytes(): Uint8Array {
    return cloneBytes(this._bytes);
  }

  /** Secret length in bytes. */
  get length(): number {
    return this._bytes.length;
  }

  /**
   * Derive `length` bytes of key material via HKDF.
   * @example
   * ```ts
   * const okm = shared.deriveBytes({ info: "securechat:kdf:v1", length: 64 });
   * ```
   */
  deriveBytes(options: DeriveOptions = {}): Uint8Array {
    return hkdf(this._bytes, {
      salt: options.salt,
      info: options.info,
      length: options.length ?? 32,
      hash: options.hash ?? HashAlgorithm.SHA256,
    });
  }

  /**
   * Derive a 32-byte {@link SymmetricKey} (AES-256-GCM) via HKDF. This is the
   * canonical way to turn a Diffie–Hellman result into an encryption key.
   *
   * @example
   * ```ts
   * const key = shared.deriveKey({ info: "securechat:session:v1" });
   * const payload = encrypt(key, "hello");
   * ```
   */
  deriveKey(options: Omit<DeriveOptions, "length"> = {}): SymmetricKey {
    const bytes = this.deriveBytes({ ...options, length: 32 });
    return SymmetricKey.fromBytes(bytes);
  }

  /** Best-effort zeroing of the internal secret. See caveats on `wipe`. */
  destroy(): void {
    wipe(this._bytes);
  }

  /** Avoid accidental secret leakage in logs / `JSON.stringify`. */
  toJSON(): string {
    return "[SharedSecret]";
  }
}

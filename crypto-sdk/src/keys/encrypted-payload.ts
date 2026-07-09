/**
 * {@link CipherText} and {@link EncryptedPayload} — value objects describing the
 * output of authenticated symmetric encryption. They know nothing about messages
 * or transport; they are pure containers with (de)serialization.
 *
 * - {@link CipherText}: the opaque encrypted body PLUS its authentication tag,
 *   i.e. everything that is secret/authenticated but not the public nonce.
 * - {@link EncryptedPayload}: the full self-describing envelope
 *   `{ version, algorithm, nonce, ciphertext, authTag }` — everything a receiver
 *   needs (together with the key and any AAD) to decrypt.
 *
 * Associated Data (AAD) is intentionally NOT stored in the envelope: it is
 * "associated" context supplied out-of-band by the caller and must be provided
 * identically to `decrypt`. Embedding it would defeat its purpose.
 */

import { PAYLOAD_FORMAT_VERSION, SymmetricAlgorithm } from "../constants/index.js";
import { InvalidCiphertextError } from "../errors/index.js";
import { fromBase64Url, toBase64Url } from "../encoding/index.js";
import { cloneBytes, assertUint8Array, assertNonEmpty } from "../utils/index.js";

/**
 * Opaque ciphertext + authentication tag. Useful when a caller wants to treat the
 * "encrypted bytes" as a single unit; the nonce is carried separately in
 * {@link EncryptedPayload}.
 */
export class CipherText {
  private readonly _ciphertext: Uint8Array;
  private readonly _authTag: Uint8Array;

  constructor(ciphertext: Uint8Array, authTag: Uint8Array) {
    assertUint8Array(ciphertext, "ciphertext");
    assertNonEmpty(authTag, "authTag");
    this._ciphertext = cloneBytes(ciphertext);
    this._authTag = cloneBytes(authTag);
  }

  /** Encrypted body bytes (may be empty for empty plaintext). */
  get ciphertext(): Uint8Array {
    return cloneBytes(this._ciphertext);
  }

  /** Authentication tag bytes (16 bytes for GCM). */
  get authTag(): Uint8Array {
    return cloneBytes(this._authTag);
  }

  /** Concatenated `ciphertext || authTag`. */
  get combined(): Uint8Array {
    const out = new Uint8Array(this._ciphertext.length + this._authTag.length);
    out.set(this._ciphertext, 0);
    out.set(this._authTag, this._ciphertext.length);
    return out;
  }
}

/** Plain-object form of an {@link EncryptedPayload} (base64url fields). */
export interface EncryptedPayloadJSON {
  /** Envelope format version. */
  v: number;
  /** Algorithm identifier. */
  alg: SymmetricAlgorithm;
  /** base64url nonce. */
  nonce: string;
  /** base64url ciphertext. */
  ct: string;
  /** base64url authentication tag. */
  tag: string;
}

/** Constructor fields for {@link EncryptedPayload}. */
export interface EncryptedPayloadFields {
  algorithm?: SymmetricAlgorithm;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}

/**
 * A self-describing AEAD envelope. Immutable; all accessors return copies.
 *
 * @example
 * ```ts
 * const payload = encrypt(key, "hello");
 * const wire = payload.serialize();               // string, safe to store/transmit
 * const restored = EncryptedPayload.deserialize(wire);
 * const plaintext = decrypt(key, restored);
 * ```
 */
export class EncryptedPayload {
  /** AEAD algorithm used. */
  public readonly algorithm: SymmetricAlgorithm;
  private readonly _nonce: Uint8Array;
  private readonly _ciphertext: Uint8Array;
  private readonly _authTag: Uint8Array;

  constructor(fields: EncryptedPayloadFields) {
    assertNonEmpty(fields.nonce, "nonce");
    assertUint8Array(fields.ciphertext, "ciphertext");
    assertNonEmpty(fields.authTag, "authTag");
    this.algorithm = fields.algorithm ?? SymmetricAlgorithm.AES_256_GCM;
    this._nonce = cloneBytes(fields.nonce);
    this._ciphertext = cloneBytes(fields.ciphertext);
    this._authTag = cloneBytes(fields.authTag);
  }

  /** The nonce/IV (12 bytes for GCM). Public value; not secret. */
  get nonce(): Uint8Array {
    return cloneBytes(this._nonce);
  }

  /** The encrypted body bytes. */
  get ciphertext(): Uint8Array {
    return cloneBytes(this._ciphertext);
  }

  /** The authentication tag bytes. */
  get authTag(): Uint8Array {
    return cloneBytes(this._authTag);
  }

  /** View of `{ ciphertext, authTag }` as a {@link CipherText}. */
  get cipherText(): CipherText {
    return new CipherText(this._ciphertext, this._authTag);
  }

  /** Convert to a plain JSON-safe object with base64url fields. */
  toJSON(): EncryptedPayloadJSON {
    return {
      v: PAYLOAD_FORMAT_VERSION,
      alg: this.algorithm,
      nonce: toBase64Url(this._nonce),
      ct: toBase64Url(this._ciphertext),
      tag: toBase64Url(this._authTag),
    };
  }

  /** Serialize to a compact JSON string suitable for storage/transport. */
  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Rebuild an {@link EncryptedPayload} from its plain-object form.
   * @throws {InvalidCiphertextError} if the object is malformed or version-incompatible.
   */
  static fromJSON(obj: EncryptedPayloadJSON): EncryptedPayload {
    if (typeof obj !== "object" || obj === null) {
      throw new InvalidCiphertextError("Encrypted payload must be an object");
    }
    if (obj.v !== PAYLOAD_FORMAT_VERSION) {
      throw new InvalidCiphertextError(
        `Unsupported payload version ${String(obj.v)} (expected ${PAYLOAD_FORMAT_VERSION})`,
      );
    }
    if (obj.alg !== SymmetricAlgorithm.AES_256_GCM) {
      throw new InvalidCiphertextError(`Unsupported algorithm ${String(obj.alg)}`);
    }
    if (typeof obj.nonce !== "string" || typeof obj.ct !== "string" || typeof obj.tag !== "string") {
      throw new InvalidCiphertextError("Encrypted payload is missing required fields");
    }
    try {
      return new EncryptedPayload({
        algorithm: obj.alg,
        nonce: fromBase64Url(obj.nonce),
        ciphertext: fromBase64Url(obj.ct),
        authTag: fromBase64Url(obj.tag),
      });
    } catch (cause) {
      throw new InvalidCiphertextError("Encrypted payload fields are not valid base64url", { cause });
    }
  }

  /**
   * Parse a serialized envelope string.
   * @throws {InvalidCiphertextError} if the string is not valid JSON or is malformed.
   */
  static deserialize(serialized: string): EncryptedPayload {
    if (typeof serialized !== "string") {
      throw new InvalidCiphertextError("Serialized payload must be a string");
    }
    let obj: EncryptedPayloadJSON;
    try {
      obj = JSON.parse(serialized) as EncryptedPayloadJSON;
    } catch (cause) {
      throw new InvalidCiphertextError("Serialized payload is not valid JSON", { cause });
    }
    return EncryptedPayload.fromJSON(obj);
  }
}

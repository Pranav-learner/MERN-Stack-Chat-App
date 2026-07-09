/**
 * @module symmetric
 *
 * The symmetric encryption engine: an ergonomic, generic wrapper over Sprint 1's
 * AES-256-GCM AEAD. It adds a key-bound {@link SymmetricEngine} handle, an
 * {@link EncryptedBuffer} payload result carrying content metadata, and re-exports
 * the chunked/streaming primitives.
 *
 * No chat-specific logic — this is a general-purpose authenticated cipher.
 */

import {
  EncryptedPayload,
  SymmetricKey,
  decrypt,
  encrypt,
  type EncryptOptions,
} from "@securechat/crypto-sdk";
import type { ContentMetadata } from "../types/index.js";
import { EncryptedBuffer } from "../payloads/index.js";

export {
  DEFAULT_CHUNK_SIZE,
  STREAM_FORMAT_VERSION,
  deriveStreamKey,
  generateStreamSalt,
  sealChunk,
  openChunk,
  chunkNonce,
  rechunk,
} from "./stream.js";

/** Options for {@link SymmetricEngine.encryptToBuffer}. */
export interface EncryptToBufferOptions extends EncryptOptions {
  /** Content metadata to attach to the resulting {@link EncryptedBuffer}. */
  metadata?: ContentMetadata;
}

/**
 * A key-bound authenticated symmetric cipher. Construct once with a key and
 * encrypt/decrypt many payloads. Each call uses a fresh random nonce.
 *
 * @example
 * ```ts
 * const engine = SymmetricEngine.withRandomKey();
 * const payload = engine.encrypt("hello", { aad: "ctx" });
 * const text = new TextDecoder().decode(engine.decrypt(payload, { aad: "ctx" }));
 * ```
 */
export class SymmetricEngine {
  constructor(private readonly _key: SymmetricKey) {}

  /** Create an engine with a fresh random AES-256 key. */
  static withRandomKey(): SymmetricEngine {
    return new SymmetricEngine(SymmetricKey.generate());
  }

  /** Create an engine bound to an existing key. */
  static withKey(key: SymmetricKey): SymmetricEngine {
    return new SymmetricEngine(key);
  }

  /** The bound key (defensive: returns the same immutable SDK object). */
  get key(): SymmetricKey {
    return this._key;
  }

  /**
   * Encrypt bytes or a UTF-8 string to a self-describing {@link EncryptedPayload}.
   * @throws {EncryptionError}
   */
  encrypt(plaintext: Uint8Array | string, options: EncryptOptions = {}): EncryptedPayload {
    return encrypt(this._key, plaintext, options);
  }

  /**
   * Decrypt and authenticate an {@link EncryptedPayload}.
   * @throws {DecryptionError} on any authentication failure.
   */
  decrypt(payload: EncryptedPayload, options: { aad?: Uint8Array | string } = {}): Uint8Array {
    return decrypt(this._key, payload, options);
  }

  /** Encrypt to an {@link EncryptedBuffer} carrying content metadata. */
  encryptToBuffer(
    plaintext: Uint8Array | string,
    options: EncryptToBufferOptions = {},
  ): EncryptedBuffer {
    const { metadata, ...encryptOptions } = options;
    const payload = encrypt(this._key, plaintext, encryptOptions);
    const meta: ContentMetadata = { ...metadata };
    if (meta.originalSize === undefined) {
      meta.originalSize = typeof plaintext === "string" ? undefined : plaintext.length;
    }
    return new EncryptedBuffer(payload, meta);
  }

  /** Decrypt an {@link EncryptedBuffer}. @throws {DecryptionError} */
  decryptBuffer(buffer: EncryptedBuffer, options: { aad?: Uint8Array | string } = {}): Uint8Array {
    return decrypt(this._key, buffer.payload, options);
  }
}

/**
 * One-shot functional encrypt: convenience over {@link SymmetricEngine}.
 * @example
 * ```ts
 * const payload = encryptData(key, "hi");
 * ```
 */
export function encryptData(
  key: SymmetricKey,
  plaintext: Uint8Array | string,
  options: EncryptOptions = {},
): EncryptedPayload {
  return encrypt(key, plaintext, options);
}

/** One-shot functional decrypt. @throws {DecryptionError} */
export function decryptData(
  key: SymmetricKey,
  payload: EncryptedPayload,
  options: { aad?: Uint8Array | string } = {},
): Uint8Array {
  return decrypt(key, payload, options);
}

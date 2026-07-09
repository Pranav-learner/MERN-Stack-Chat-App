/**
 * @module symmetric/stream
 *
 * Low-level chunked AEAD primitives shared by the file/streaming APIs.
 *
 * ## Construction (secure chunked stream, format v1)
 * - A random 16-byte `streamSalt` is generated per stream; a per-stream key is
 *   derived via HKDF: `streamKey = HKDF(baseKey, salt=streamSalt,
 *   info="securechat:file-stream:v1")`. Because every stream has a unique key,
 *   counter-based nonces are safe (no cross-stream nonce reuse).
 * - Each chunk uses a 12-byte big-endian counter nonce (`index`).
 * - Each chunk's AEAD Associated Data binds `version | algorithm | chunkSize |
 *   streamSalt | index | isFinal`. This authenticates structural parameters and
 *   provides:
 *   - **reordering protection** — the index is bound, so swapping chunks fails;
 *   - **truncation protection** — only the last chunk has `isFinal = 1`, so a
 *     stream cut short never yields a valid final chunk;
 *   - **duplication protection** — a duplicated chunk has the wrong index/final flag.
 *
 * Each stored chunk is `ciphertext || authTag` (the nonce is recomputed from the
 * index on decrypt, so it is not stored).
 */

import {
  EncryptedPayload,
  GCM_TAG_BYTES,
  SymmetricKey,
  decrypt,
  encrypt,
  fromBase64,
  hkdf,
  randomBytes,
  toBase64,
  utf8ToBytes,
} from "@securechat/crypto-sdk";
import type { EncryptedFileHeader } from "../types/index.js";
import { StreamError } from "../errors/index.js";

/** Default plaintext chunk size (64 KiB). */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Stream salt length in bytes. */
export const STREAM_SALT_BYTES = 16;

/** Current encrypted-file/stream format version. */
export const STREAM_FORMAT_VERSION = 1;

const STREAM_KEY_INFO = utf8ToBytes("securechat:file-stream:v1");

/** Generate a fresh per-stream salt. */
export function generateStreamSalt(): Uint8Array {
  return randomBytes(STREAM_SALT_BYTES);
}

/** Derive the per-stream key from a base key and stream salt via HKDF. */
export function deriveStreamKey(baseKey: SymmetricKey, streamSalt: Uint8Array): SymmetricKey {
  const bytes = hkdf(baseKey.bytes, { salt: streamSalt, info: STREAM_KEY_INFO, length: 32 });
  return SymmetricKey.fromBytes(bytes);
}

/** 12-byte big-endian counter nonce for a chunk index. */
export function chunkNonce(index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new StreamError(`Invalid chunk index: ${index}`);
  }
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  // Put the 64-bit counter in the last 8 bytes; first 4 bytes stay zero.
  view.setBigUint64(4, BigInt(index), false);
  return nonce;
}

/** Build the per-chunk Associated Data binding structural parameters. */
export function chunkAAD(header: EncryptedFileHeader, index: number, isFinal: boolean): Uint8Array {
  return utf8ToBytes(
    `${header.version}|${header.algorithm}|${header.chunkSize}|${header.streamSalt}|${index}|${isFinal ? 1 : 0}`,
  );
}

/**
 * Encrypt one plaintext chunk; returns base64(`ciphertext || authTag`).
 * @throws {StreamError}
 */
export function sealChunk(
  streamKey: SymmetricKey,
  header: EncryptedFileHeader,
  index: number,
  isFinal: boolean,
  plaintext: Uint8Array,
): string {
  try {
    const payload = encrypt(streamKey, plaintext, {
      aad: chunkAAD(header, index, isFinal),
      nonce: chunkNonce(index),
    });
    const combined = new Uint8Array(payload.ciphertext.length + payload.authTag.length);
    combined.set(payload.ciphertext, 0);
    combined.set(payload.authTag, payload.ciphertext.length);
    return toBase64(combined);
  } catch (cause) {
    throw new StreamError(`Failed to seal chunk ${index}`, { cause });
  }
}

/**
 * Decrypt one chunk (base64 `ciphertext || authTag`) back to plaintext.
 * Authenticates against the same index / isFinal / header AAD.
 * @throws {StreamError} on authentication failure (tamper / wrong key / reorder / truncation).
 */
export function openChunk(
  streamKey: SymmetricKey,
  header: EncryptedFileHeader,
  index: number,
  isFinal: boolean,
  data: string,
): Uint8Array {
  let combined: Uint8Array;
  try {
    combined = fromBase64(data);
  } catch (cause) {
    throw new StreamError(`Chunk ${index} is not valid base64`, { cause });
  }
  if (combined.length < GCM_TAG_BYTES) {
    throw new StreamError(`Chunk ${index} is too short to contain an auth tag`);
  }
  const ciphertext = combined.slice(0, combined.length - GCM_TAG_BYTES);
  const authTag = combined.slice(combined.length - GCM_TAG_BYTES);
  try {
    const payload = new EncryptedPayload({ nonce: chunkNonce(index), ciphertext, authTag });
    return decrypt(streamKey, payload, { aad: chunkAAD(header, index, isFinal) });
  } catch (cause) {
    throw new StreamError(
      `Chunk ${index} failed authentication (tampered, wrong key, reordered, or truncated)`,
      { cause },
    );
  }
}

/**
 * Re-chunk an (async) byte source into fixed-size plaintext chunks, tagging the
 * last one `isFinal`. Memory-bounded (holds at most ~2 chunks). Always yields at
 * least one chunk (an empty final chunk for an empty source), so every stream
 * has an authenticated terminator.
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<{ data: Uint8Array; isFinal: boolean }> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new StreamError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  let buffer = new Uint8Array(0);
  const append = (piece: Uint8Array): void => {
    const next = new Uint8Array(buffer.length + piece.length);
    next.set(buffer, 0);
    next.set(piece, buffer.length);
    buffer = next;
  };

  for await (const piece of source as AsyncIterable<Uint8Array>) {
    append(piece);
    // Emit only while strictly more than a chunk remains, so we always retain a
    // non-empty tail to flag as final after the source ends.
    while (buffer.length > chunkSize) {
      yield { data: buffer.slice(0, chunkSize), isFinal: false };
      buffer = buffer.slice(chunkSize);
    }
  }
  // Flush the remainder as the final chunk (may be empty for an empty source).
  yield { data: buffer, isFinal: true };
}

/**
 * @module file
 *
 * Generic, chunk-based file encryption on top of the streaming primitives. Works
 * on in-memory buffers and on (async) streams, is memory-bounded for large
 * inputs, and is authenticated per chunk with reorder/truncation protection.
 *
 * No coupling to uploads, storage, or chat — it encrypts bytes.
 */

import { SymmetricKey, fromBase64, toBase64 } from "@securechat/crypto-sdk";
import type {
  ContentMetadata,
  EncryptedFileHeader,
  EncryptedStreamFrame,
} from "../types/index.js";
import { EncryptedAttachment, EncryptedFile } from "../payloads/index.js";
import { FileEncryptionError, StreamError } from "../errors/index.js";
import {
  DEFAULT_CHUNK_SIZE,
  STREAM_FORMAT_VERSION,
  deriveStreamKey,
  generateStreamSalt,
  openChunk,
  rechunk,
  sealChunk,
} from "../symmetric/stream.js";

/** Options for buffer/stream encryption. */
export interface FileEncryptOptions {
  /** Plaintext chunk size in bytes (default 64 KiB). */
  chunkSize?: number;
  /** Content metadata to record in the header. */
  metadata?: ContentMetadata;
}

/**
 * Chunk-based file encryptor.
 *
 * @example Buffer mode
 * ```ts
 * const fe = new FileEncryptor();
 * const enc = fe.encryptBuffer(fileBytes, key, { metadata: { contentType: "image/png" } });
 * const wire = enc.serialize();
 * const back = fe.decryptBuffer(EncryptedFile.deserialize(wire), key); // === fileBytes
 * ```
 *
 * @example Streaming mode (memory-bounded)
 * ```ts
 * const frames = fe.encryptStream(sourceAsyncIterable, key);
 * for await (const plaintextChunk of fe.decryptStream(frames, key)) { sink.write(plaintextChunk); }
 * ```
 */
export class FileEncryptor {
  private readonly chunkSize: number;

  constructor(options: { chunkSize?: number } = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize < 1) {
      throw new FileEncryptionError("chunkSize must be a positive integer");
    }
  }

  /** Build a stream header for a new encryption. */
  private buildHeader(streamSalt: Uint8Array, chunkSize: number, metadata: ContentMetadata): EncryptedFileHeader {
    return {
      format: "securechat-encrypted-file",
      version: STREAM_FORMAT_VERSION,
      algorithm: "AES-256-GCM",
      streamSalt: toBase64(streamSalt),
      chunkSize,
      metadata,
    };
  }

  /**
   * Encrypt an in-memory buffer into an {@link EncryptedFile}.
   * @throws {FileEncryptionError}
   */
  encryptBuffer(data: Uint8Array, key: SymmetricKey, options: FileEncryptOptions = {}): EncryptedFile {
    if (!(data instanceof Uint8Array)) throw new FileEncryptionError("data must be a Uint8Array");
    const chunkSize = options.chunkSize ?? this.chunkSize;
    const streamSalt = generateStreamSalt();
    const streamKey = deriveStreamKey(key, streamSalt);
    const metadata: ContentMetadata = { originalSize: data.length, ...options.metadata };
    const header = this.buildHeader(streamSalt, chunkSize, metadata);

    const chunks: string[] = [];
    const total = data.length;
    // At least one chunk (an empty final chunk for empty input) so every file has
    // an authenticated terminator.
    if (total === 0) {
      chunks.push(sealChunk(streamKey, header, 0, true, new Uint8Array(0)));
    } else {
      let index = 0;
      for (let offset = 0; offset < total; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, total);
        const isFinal = end === total;
        chunks.push(sealChunk(streamKey, header, index, isFinal, data.slice(offset, end)));
        index++;
      }
    }
    return new EncryptedFile(header, chunks);
  }

  /**
   * Decrypt an {@link EncryptedFile} back to bytes. Verifies chunk order and that
   * the file terminates with an authenticated final chunk.
   * @throws {FileEncryptionError} on any authentication/structure failure.
   */
  decryptBuffer(file: EncryptedFile, key: SymmetricKey): Uint8Array {
    if (!(file instanceof EncryptedFile)) throw new FileEncryptionError("Expected an EncryptedFile");
    const header = file.header;
    if (header.format !== "securechat-encrypted-file") {
      throw new FileEncryptionError("Unrecognized encrypted-file header");
    }
    if (header.version !== STREAM_FORMAT_VERSION) {
      throw new FileEncryptionError(`Unsupported encrypted-file version ${header.version}`);
    }
    if (file.chunks.length === 0) {
      throw new FileEncryptionError("Encrypted file has no chunks");
    }
    let streamSalt: Uint8Array;
    try {
      streamSalt = fromBase64(header.streamSalt);
    } catch (cause) {
      throw new FileEncryptionError("Encrypted-file header has an invalid streamSalt", { cause });
    }
    const streamKey = deriveStreamKey(key, streamSalt);

    const parts: Uint8Array[] = [];
    const lastIndex = file.chunks.length - 1;
    for (let index = 0; index < file.chunks.length; index++) {
      const isFinal = index === lastIndex;
      try {
        parts.push(openChunk(streamKey, header, index, isFinal, file.chunks[index]!));
      } catch (cause) {
        throw new FileEncryptionError(`Failed to decrypt chunk ${index}`, { cause });
      }
    }
    return concat(parts);
  }

  /** Encrypt into an {@link EncryptedAttachment} (metadata guarantees a contentType). */
  encryptAttachment(
    data: Uint8Array,
    key: SymmetricKey,
    options: { contentType: string; name?: string; chunkSize?: number; custom?: Record<string, unknown> },
  ): EncryptedAttachment {
    const metadata: ContentMetadata = { contentType: options.contentType };
    if (options.name !== undefined) metadata.name = options.name;
    if (options.custom !== undefined) metadata.custom = options.custom;
    const encryptOptions: FileEncryptOptions = { metadata };
    if (options.chunkSize !== undefined) encryptOptions.chunkSize = options.chunkSize;
    const file = this.encryptBuffer(data, key, encryptOptions);
    return new EncryptedAttachment(file.header, file.chunks);
  }

  /**
   * Encrypt a byte stream, yielding a header frame followed by chunk frames.
   * Memory-bounded — suitable for very large inputs.
   */
  async *encryptStream(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    key: SymmetricKey,
    options: FileEncryptOptions = {},
  ): AsyncGenerator<EncryptedStreamFrame> {
    const chunkSize = options.chunkSize ?? this.chunkSize;
    const streamSalt = generateStreamSalt();
    const streamKey = deriveStreamKey(key, streamSalt);
    const header = this.buildHeader(streamSalt, chunkSize, { ...options.metadata });
    yield { type: "header", header };

    let index = 0;
    for await (const { data, isFinal } of rechunk(source, chunkSize)) {
      yield { type: "chunk", index, isFinal, data: sealChunk(streamKey, header, index, isFinal, data) };
      index++;
    }
  }

  /**
   * Decrypt a stream of frames (header first, then chunks) back into plaintext
   * chunks. Enforces frame ordering and terminates only on the authenticated
   * final chunk.
   * @throws {StreamError} on ordering/structure/authentication failure.
   */
  async *decryptStream(
    frames: AsyncIterable<EncryptedStreamFrame> | Iterable<EncryptedStreamFrame>,
    key: SymmetricKey,
  ): AsyncGenerator<Uint8Array> {
    let header: EncryptedFileHeader | undefined;
    let streamKey: SymmetricKey | undefined;
    let expectedIndex = 0;
    let sawFinal = false;

    for await (const frame of frames as AsyncIterable<EncryptedStreamFrame>) {
      if (frame.type === "header") {
        if (header) throw new StreamError("Duplicate stream header");
        header = frame.header;
        if (header.format !== "securechat-encrypted-file") {
          throw new StreamError("Unrecognized stream header");
        }
        streamKey = deriveStreamKey(key, fromBase64(header.streamSalt));
        continue;
      }
      // chunk frame
      if (!header || !streamKey) throw new StreamError("Chunk frame received before header");
      if (sawFinal) throw new StreamError("Chunk frame received after the final chunk");
      if (frame.index !== expectedIndex) {
        throw new StreamError(`Out-of-order chunk: expected ${expectedIndex}, got ${frame.index}`);
      }
      yield openChunk(streamKey, header, frame.index, frame.isFinal, frame.data);
      expectedIndex++;
      if (frame.isFinal) sawFinal = true;
    }
    if (!header) throw new StreamError("Stream ended without a header");
    if (!sawFinal) throw new StreamError("Stream ended before the final chunk (possible truncation)");
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * @module transport-engine/fragmentation
 *
 * **Payload fragmentation.** Splits a large ALREADY-ENCRYPTED payload into ordered, checksummed chunks
 * of a (variable) size. Produces the chunk set + the aggregate metadata (total size, count, overall
 * integrity checksum) a receiver needs to reassemble + validate.
 *
 * @security Fragments OPAQUE CIPHERTEXT — it slices bytes, never decrypts. Each fragment is itself
 * ciphertext; per-fragment + whole-payload checksums are integrity hashes over that ciphertext (not
 * keys). Future streaming reuses this by fragmenting a stream window instead of a whole payload — the
 * chunk shape is identical (the `stream` seam).
 *
 * @performance O(n) over the payload with a single hash pass per fragment + one aggregate pass. Chunk
 * `data` is stored base64 (portable); callers stream large payloads through `fragmentPayload` once and
 * persist chunks to the repository so the whole payload need not stay resident.
 */

import crypto from "node:crypto";
import { createChunk, toBuffer, chunkIdFor } from "../chunks/chunk.js";
import {
  DEFAULT_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_PAYLOAD_SIZE,
  TransferPriority,
} from "../types/types.js";
import { ChunkValidationError, PayloadTooLargeError } from "../errors.js";

/**
 * Fragment an encrypted payload into chunks.
 *
 * @param {Buffer|Uint8Array|string} payload the opaque ciphertext (Buffer/Uint8Array/base64 string)
 * @param {object} [options]
 * @param {string} [options.transferId] @param {string} [options.conversationId]
 * @param {number} [options.chunkSize] fragment size in bytes (clamped to [MIN,MAX]_CHUNK_SIZE)
 * @param {string} [options.priority] chunk scheduling priority
 * @returns {{ chunks: import("../types/types.js").Chunk[], totalChunks: number, totalSize: number, chunkSize: number, checksum: string }}
 */
export function fragmentPayload(payload, options = {}) {
  const bytes = toBuffer(payload);
  const totalSize = bytes.length;
  if (totalSize === 0) throw new ChunkValidationError("Cannot fragment an empty payload");
  if (totalSize > MAX_PAYLOAD_SIZE) {
    throw new PayloadTooLargeError(`Payload of ${totalSize} bytes exceeds the ${MAX_PAYLOAD_SIZE}-byte maximum`, { details: { totalSize, max: MAX_PAYLOAD_SIZE } });
  }
  const chunkSize = clampChunkSize(options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const transferId = options.transferId ?? crypto.randomUUID();
  const conversationId = options.conversationId ?? "unknown";
  const priority = options.priority ?? TransferPriority.FILE;

  const totalChunks = Math.max(1, Math.ceil(totalSize / chunkSize));
  const chunks = [];
  const aggregate = crypto.createHash("sha256");
  for (let index = 0; index < totalChunks; index++) {
    const offset = index * chunkSize;
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, totalSize));
    aggregate.update(slice);
    chunks.push(
      createChunk({
        transferId,
        conversationId,
        index,
        total: totalChunks,
        offset,
        data: slice,
        priority,
        chunkId: chunkIdFor(transferId, index),
      }),
    );
  }
  return { chunks, totalChunks, totalSize, chunkSize, checksum: aggregate.digest("hex"), transferId };
}

/** Clamp a requested chunk size into the permitted range. @throws {ChunkValidationError} */
export function clampChunkSize(size) {
  if (!Number.isInteger(size) || size <= 0) throw new ChunkValidationError("chunkSize must be a positive integer", { details: { size } });
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, size));
}

/** How many chunks a payload of `totalSize` bytes will produce at `chunkSize`. */
export function chunkCountFor(totalSize, chunkSize = DEFAULT_CHUNK_SIZE) {
  return Math.max(1, Math.ceil(totalSize / clampChunkSize(chunkSize)));
}

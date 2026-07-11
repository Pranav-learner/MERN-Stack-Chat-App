/**
 * @module transport-engine/chunks
 *
 * The **Chunk** model — the record factory + pure helpers for a single payload fragment. A chunk binds
 * a transfer + conversation to an OPAQUE ciphertext fragment (`data`, base64), its position (`index` /
 * `offset` / `size` / `total`), an integrity `checksum`, and retransmission bookkeeping.
 *
 * @security A chunk carries CIPHERTEXT ONLY. `data` is a slice of the crypto layer's ciphertext; the
 * transport engine never decodes it. `checksum` is an integrity hash over those ciphertext bytes — it
 * is NOT key material and does not weaken the encryption. There is no plaintext / key field.
 */

import crypto from "node:crypto";
import { ChunkState, TransferPriority } from "../types/types.js";

/** Normalize a payload / fragment into a Buffer (accepts Buffer, Uint8Array, or base64 string). */
export function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "base64");
  throw new TypeError("chunk data must be a Buffer, Uint8Array, or base64 string");
}

/** An integrity checksum (sha256 hex) over opaque ciphertext bytes. Not a secret. */
export function checksumOf(bytes) {
  return crypto.createHash("sha256").update(toBuffer(bytes)).digest("hex");
}

/** A deterministic, ordered chunk id for a transfer position. */
export function chunkIdFor(transferId, index) {
  return `${transferId}#${String(index).padStart(8, "0")}`;
}

/**
 * Build a chunk record in the {@link ChunkState.PENDING} state.
 *
 * @param {object} params
 * @param {string} params.transferId @param {string} params.conversationId
 * @param {number} params.index @param {number} params.total @param {number} params.offset
 * @param {Buffer|Uint8Array|string} params.data the opaque ciphertext fragment
 * @param {string} [params.priority] @param {string} [params.checksum] precomputed integrity hash
 * @returns {import("../types/types.js").Chunk}
 */
export function createChunk(params) {
  const bytes = toBuffer(params.data);
  return {
    chunkId: params.chunkId ?? chunkIdFor(params.transferId, params.index),
    transferId: String(params.transferId),
    conversationId: String(params.conversationId),
    index: params.index,
    total: params.total,
    offset: params.offset,
    size: bytes.length,
    data: bytes.toString("base64"), // OPAQUE ciphertext fragment
    checksum: params.checksum ?? checksumOf(bytes),
    state: ChunkState.PENDING,
    retryCount: 0,
    nextRetryAt: null,
    priority: params.priority ?? TransferPriority.FILE,
    createdAt: params.createdAt ?? null,
  };
}

/** Verify a chunk's `data` matches its `checksum` (corruption/tamper detection over ciphertext). */
export function verifyChunk(chunk) {
  try {
    return checksumOf(chunk.data) === chunk.checksum;
  } catch {
    return false;
  }
}

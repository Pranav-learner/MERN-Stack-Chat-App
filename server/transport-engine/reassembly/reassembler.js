/**
 * @module transport-engine/reassembly
 *
 * **Payload reconstruction.** Collects a transfer's chunks (arriving in any order), detects duplicate
 * + missing chunks, validates each fragment's integrity checksum, detects completion, and reconstructs
 * the original OPAQUE ciphertext payload — then validates the whole-payload checksum. Supports
 * timeouts + partial-transfer recovery (report exactly which chunks are still missing so the sender
 * can resend just those).
 *
 * @security Reassembles CIPHERTEXT ONLY. Integrity checks are checksums over ciphertext; the engine
 * never decrypts. The reconstructed payload is opaque and handed to the app for decryption.
 *
 * @performance Chunks are held in a Map keyed by index (O(1) insert/dup-check). Completion is tracked
 * by a received-count so `isComplete` is O(1). Reconstruction concatenates in index order once, at the
 * end — a single O(n) pass.
 */

import { toBuffer, checksumOf } from "../chunks/chunk.js";
import { TransferCorruptedError, MissingChunkError, ChunkValidationError } from "../errors.js";

export class Reassembler {
  /**
   * @param {object} params
   * @param {string} params.transferId @param {number} params.totalChunks @param {number} [params.totalSize]
   * @param {string} [params.checksum] the expected whole-payload integrity checksum
   */
  constructor(params) {
    if (!params?.transferId || !Number.isInteger(params.totalChunks) || params.totalChunks < 1) {
      throw new ChunkValidationError("Reassembler requires { transferId, totalChunks >= 1 }");
    }
    this.transferId = String(params.transferId);
    this.totalChunks = params.totalChunks;
    this.totalSize = params.totalSize ?? null;
    this.expectedChecksum = params.checksum ?? null;
    /** @type {Map<number, { size: number, data: string, checksum: string }>} index -> fragment */
    this._chunks = new Map();
    this._bytes = 0;
  }

  /**
   * Accept a chunk. @returns {{ outcome: "accepted"|"duplicate"|"invalid", complete: boolean, received: number }}
   */
  accept(chunk) {
    const index = chunk.index;
    if (!Number.isInteger(index) || index < 0 || index >= this.totalChunks) {
      return { outcome: "invalid", complete: this.isComplete(), received: this._chunks.size, reason: "index-out-of-range" };
    }
    // Integrity: the fragment bytes must match its checksum.
    if (checksumOf(chunk.data) !== chunk.checksum) {
      return { outcome: "invalid", complete: this.isComplete(), received: this._chunks.size, reason: "checksum-mismatch" };
    }
    if (this._chunks.has(index)) {
      return { outcome: "duplicate", complete: this.isComplete(), received: this._chunks.size };
    }
    this._chunks.set(index, { size: chunk.size, data: chunk.data, checksum: chunk.checksum });
    this._bytes += chunk.size;
    return { outcome: "accepted", complete: this.isComplete(), received: this._chunks.size };
  }

  /** Whether every chunk has been received. */
  isComplete() {
    return this._chunks.size === this.totalChunks;
  }

  /** How many chunks are still outstanding. */
  get missingCount() {
    return this.totalChunks - this._chunks.size;
  }

  /** The set of still-missing chunk indices (for partial-recovery resend requests). */
  missingIndices() {
    const missing = [];
    for (let i = 0; i < this.totalChunks; i++) if (!this._chunks.has(i)) missing.push(i);
    return missing;
  }

  /** Fraction complete in `[0,1]`. */
  get progress() {
    return this.totalChunks === 0 ? 1 : this._chunks.size / this.totalChunks;
  }

  get bytesReceived() {
    return this._bytes;
  }
  get received() {
    return this._chunks.size;
  }

  /**
   * Reconstruct the full opaque ciphertext payload. @throws {MissingChunkError} if incomplete,
   * {@link TransferCorruptedError} if the whole-payload checksum fails.
   * @returns {{ payload: string, totalSize: number, checksum: string }} base64 payload
   */
  reconstruct() {
    if (!this.isComplete()) {
      throw new MissingChunkError(`Transfer ${this.transferId} is incomplete (${this.missingCount} missing)`, { details: { missing: this.missingIndices().slice(0, 64) } });
    }
    const ordered = [];
    for (let i = 0; i < this.totalChunks; i++) ordered.push(toBuffer(this._chunks.get(i).data));
    const full = Buffer.concat(ordered);
    const checksum = checksumOf(full);
    if (this.expectedChecksum && checksum !== this.expectedChecksum) {
      throw new TransferCorruptedError(`Transfer ${this.transferId} failed whole-payload integrity check`, { details: { expected: this.expectedChecksum, actual: checksum } });
    }
    return { payload: full.toString("base64"), totalSize: full.length, checksum };
  }

  /** A snapshot for persistence / diagnostics. */
  snapshot() {
    return { transferId: this.transferId, totalChunks: this.totalChunks, received: this._chunks.size, missing: this.missingCount, bytesReceived: this._bytes, complete: this.isComplete() };
  }
}

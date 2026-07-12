/**
 * @module media-delivery/buffering
 *
 * **Streaming buffer** — the sliding window of chunk indices a streaming session keeps buffered ahead of
 * the playback cursor, plus an ADAPTIVE-BUFFER placeholder (a hook that a future bandwidth-aware policy
 * fills in). Pure, allocation-light: it tracks INDICES + counts, never the chunk bytes (those flow to the
 * client and aren't retained server-side). This is the transport-buffering layer; per-chunk media bytes
 * are the client's concern.
 *
 * @security The buffer holds chunk indices + counts ONLY — no ciphertext, no plaintext, no keys.
 */

import { DEFAULT_BUFFER_CHUNKS } from "../types/types.js";

export class StreamBuffer {
  /** @param {{ chunkCount: number, windowChunks?: number }} params */
  constructor(params = {}) {
    this.chunkCount = params.chunkCount ?? 0;
    this.windowChunks = params.windowChunks ?? DEFAULT_BUFFER_CHUNKS;
    this.cursor = 0; // current playback chunk index
    this._buffered = new Set(); // chunk indices marked buffered/delivered
  }

  /** Mark a chunk buffered (delivered to the client). */
  add(index) {
    if (index >= 0 && index < this.chunkCount) this._buffered.add(index);
    return this;
  }

  /** Whether a chunk is buffered. */
  has(index) {
    return this._buffered.has(index);
  }

  /** The highest CONTIGUOUS buffered index from the start (how far playback can go without stalling). */
  contiguousUpTo() {
    let i = 0;
    while (this._buffered.has(i)) i++;
    return i - 1; // -1 if nothing buffered
  }

  /** The next chunk indices the session should fetch to fill the window ahead of the cursor. */
  nextToFetch() {
    const out = [];
    for (let i = this.cursor; i < Math.min(this.chunkCount, this.cursor + this.windowChunks); i++) {
      if (!this._buffered.has(i)) out.push(i);
    }
    return out;
  }

  /** Move the cursor (seek). Clamped. */
  seek(index) {
    this.cursor = Math.max(0, Math.min(this.chunkCount - 1, Math.floor(index)));
    return this.cursor;
  }

  /** Whether every chunk is buffered. */
  isComplete() {
    return this.chunkCount > 0 && this._buffered.size >= this.chunkCount;
  }

  /** How full the window ahead of the cursor is, in `[0,1]` (buffer health). */
  fillRatio() {
    const windowEnd = Math.min(this.chunkCount, this.cursor + this.windowChunks);
    const windowSize = Math.max(1, windowEnd - this.cursor);
    let filled = 0;
    for (let i = this.cursor; i < windowEnd; i++) if (this._buffered.has(i)) filled++;
    return Number((filled / windowSize).toFixed(4));
  }

  /** A serializable snapshot (indices + counts). */
  snapshot() {
    return {
      cursor: this.cursor,
      buffered: this._buffered.size,
      contiguous: this.contiguousUpTo(),
      windowChunks: this.windowChunks,
      fillRatio: this.fillRatio(),
      bufferWindow: [...this._buffered].filter((i) => i >= this.cursor && i < this.cursor + this.windowChunks).sort((a, b) => a - b),
    };
  }

  /** Restore from a persisted set of buffered indices. */
  restore(indices = [], cursor = 0) {
    this._buffered = new Set(indices);
    this.cursor = cursor;
    return this;
  }

  /**
   * ADAPTIVE-BUFFER placeholder — a future bandwidth-aware policy resizes the window here. Sprint 2
   * returns the current window unchanged; the hook signature is the stable seam.
   * @param {{ throughputBytesPerSec?: number, rttMs?: number }} [signals]
   */
  adaptWindow(signals = {}) {
    // Inert this sprint: a future policy computes `windowChunks` from throughput/RTT signals.
    return this.windowChunks;
  }
}

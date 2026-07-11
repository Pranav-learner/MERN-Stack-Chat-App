/**
 * @module transport-reliability/resume
 *
 * **Resume planning.** From a transfer's CHECKPOINT (how far it got before an interruption), compute a
 * RESUME PLAN: exactly which chunks still need sending, so a recovered transfer re-sends ONLY the
 * missing fragments — never restarting from zero and never re-transmitting acknowledged chunks.
 *
 * Two modes:
 * - **precise** — the checkpoint carries `missingIndices` (a gap list from the reassembler); resume
 *   sends exactly those.
 * - **high-water** — otherwise, resume from `highWaterMark + 1` (the first chunk after the last
 *   contiguously-acknowledged one). Any already-acked chunk above the mark that gets re-sent is a
 *   harmless duplicate the Transport Engine's dedup drops — so this can never corrupt the payload.
 *
 * @security Operates on chunk COUNTS + indices only — never payload bytes or keys. It is a pure
 * function; it never mutates the checkpoint or the record (so recovery can never corrupt transfer
 * state).
 *
 * @example
 * ```js
 * const plan = planResume({ totalChunks: 100, highWaterMark: 39, chunksAcked: 40 });
 * // → { fromIndex: 40, remaining: 60, resumable: true, mode: "high-water" }
 * ```
 */

import { ReliabilityValidationError } from "../errors.js";

/**
 * Compute a resume plan from a checkpoint. Pure — never mutates.
 * @param {import("../types/types.js").TransferCheckpoint} checkpoint
 * @param {{ now?: number }} [options]
 * @returns {{ resumable: boolean, mode: "precise"|"high-water"|"complete", fromIndex: number, remaining: number, totalChunks: number, missingIndices: number[]|null, plannedAt: string }}
 */
export function planResume(checkpoint, options = {}) {
  if (!checkpoint || typeof checkpoint !== "object") throw new ReliabilityValidationError("A checkpoint is required to plan a resume");
  const totalChunks = checkpoint.totalChunks;
  if (!Number.isInteger(totalChunks) || totalChunks < 1) throw new ReliabilityValidationError("checkpoint.totalChunks must be >= 1", { details: { totalChunks } });
  const plannedAt = new Date(options.now ?? Date.now()).toISOString();

  // Precise partial recovery: an explicit gap list.
  if (Array.isArray(checkpoint.missingIndices) && checkpoint.missingIndices.length > 0) {
    const missing = [...new Set(checkpoint.missingIndices)].filter((i) => Number.isInteger(i) && i >= 0 && i < totalChunks).sort((a, b) => a - b);
    return { resumable: missing.length > 0, mode: "precise", fromIndex: missing[0] ?? totalChunks, remaining: missing.length, totalChunks, missingIndices: missing, plannedAt };
  }

  // High-water resume: everything after the last contiguously-acked chunk.
  const highWater = Number.isInteger(checkpoint.highWaterMark) ? checkpoint.highWaterMark : -1;
  const fromIndex = Math.max(0, Math.min(highWater + 1, totalChunks));
  const remaining = totalChunks - fromIndex;
  if (remaining <= 0) return { resumable: false, mode: "complete", fromIndex: totalChunks, remaining: 0, totalChunks, missingIndices: [], plannedAt };
  return { resumable: true, mode: "high-water", fromIndex, remaining, totalChunks, missingIndices: null, plannedAt };
}

/**
 * Merge a fresh progress report into a checkpoint (monotonic — never goes backwards). Pure; returns a
 * NEW checkpoint. This is how the manager advances a resumable checkpoint from Transport-Engine
 * progress without ever regressing it (so a late/duplicate report can't corrupt the resume point).
 * @param {import("../types/types.js").TransferCheckpoint} prev
 * @param {Partial<import("../types/types.js").TransferCheckpoint>} update
 * @param {{ now?: number }} [options]
 * @returns {import("../types/types.js").TransferCheckpoint}
 */
export function advanceCheckpoint(prev, update, options = {}) {
  const base = prev ?? { totalChunks: update.totalChunks ?? 1, chunksAcked: 0, bytesTransferred: 0, highWaterMark: -1, outstanding: 0, retryCount: 0 };
  const next = {
    totalChunks: update.totalChunks ?? base.totalChunks,
    chunksAcked: Math.max(base.chunksAcked ?? 0, update.chunksAcked ?? 0),
    bytesTransferred: Math.max(base.bytesTransferred ?? 0, update.bytesTransferred ?? 0),
    highWaterMark: Math.max(base.highWaterMark ?? -1, Number.isInteger(update.highWaterMark) ? update.highWaterMark : -1),
    outstanding: update.outstanding ?? base.outstanding ?? 0,
    retryCount: Math.max(base.retryCount ?? 0, update.retryCount ?? 0),
    checkpointAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  if (Array.isArray(update.missingIndices)) next.missingIndices = [...update.missingIndices];
  else if (Array.isArray(base.missingIndices)) next.missingIndices = [...base.missingIndices];
  return next;
}

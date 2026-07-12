/**
 * @module media-reliability/recovery/checkpoint
 *
 * **Media-operation checkpoint helpers.** A media operation's resumable progress is a small monotonic
 * record — how many chunks completed, the resume cursor, failed/pending/retried counts, and bytes
 * transferred. Advancing it never regresses (a late or duplicate report can't rewind progress), so a
 * resume re-transfers only the remaining chunks and INTEGRITY + METADATA CONSISTENCY are preserved (the
 * whole-object hash + per-chunk hashes are still verified by the Sprint-1/2 pipeline).
 *
 * @security Counts only — no content, no keys. Pure functions.
 */

/**
 * Merge a fresh progress report into a checkpoint (monotonic — never goes backwards for cumulative
 * fields). Pure; returns a NEW checkpoint. @param {import("../types/types.js").MediaCheckpoint} prev
 * @param {object} update @param {{ now?: number }} [options] @returns {import("../types/types.js").MediaCheckpoint}
 */
export function advanceCheckpoint(prev, update, options = {}) {
  const base = prev ?? { totalChunks: update.totalChunks ?? 0, completedChunks: 0, cursor: 0, failedChunks: 0, pendingChunks: 0, retriedChunks: 0, bytesTotal: update.bytesTotal ?? 0, bytesTransferred: 0 };
  return {
    totalChunks: Math.max(base.totalChunks ?? 0, update.totalChunks ?? 0),
    completedChunks: Math.max(base.completedChunks ?? 0, update.completedChunks ?? 0),
    cursor: Math.max(base.cursor ?? 0, update.cursor ?? update.completedChunks ?? 0),
    // failed/pending are the LATEST reported snapshot (they can go down as retries succeed).
    failedChunks: update.failedChunks ?? base.failedChunks ?? 0,
    pendingChunks: update.pendingChunks ?? base.pendingChunks ?? 0,
    retriedChunks: Math.max(base.retriedChunks ?? 0, update.retriedChunks ?? 0),
    bytesTotal: Math.max(base.bytesTotal ?? 0, update.bytesTotal ?? 0),
    bytesTransferred: Math.max(base.bytesTransferred ?? 0, update.bytesTransferred ?? 0),
    checkpointAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

/**
 * Compute the resume plan from a checkpoint (which chunks remain). Pure — never mutates. @returns
 * {{ resumable: boolean, fromCursor: number, remaining: number, totalChunks: number, bytesRemaining: number, plannedAt: string }}
 */
export function planResume(checkpoint, options = {}) {
  const total = checkpoint?.totalChunks ?? 0;
  const cursor = Math.max(0, Math.min(checkpoint?.cursor ?? checkpoint?.completedChunks ?? 0, total));
  const remaining = Math.max(0, total - cursor);
  const bytesRemaining = Math.max(0, (checkpoint?.bytesTotal ?? 0) - (checkpoint?.bytesTransferred ?? 0));
  return { resumable: remaining > 0, fromCursor: cursor, remaining, totalChunks: total, bytesRemaining, plannedAt: new Date(options.now ?? Date.now()).toISOString() };
}

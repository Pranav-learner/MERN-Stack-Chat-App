/**
 * @module synchronization-reliability/recovery/checkpoint
 *
 * **Sync checkpoint helpers.** A synchronization's resumable progress is a small monotonic record —
 * how many operations completed, the resume cursor, conflict/merge counts, pending operations, and the
 * replica drift. Advancing it never regresses (a late/duplicate report can't rewind progress), so a
 * resume re-runs only the remaining operations and replica consistency is preserved.
 *
 * @security Counts only — no content, no keys. Pure functions.
 */

/**
 * Merge a fresh progress report into a checkpoint (monotonic — never goes backwards). Pure; returns a
 * NEW checkpoint. @param {import("../types/types.js").SyncCheckpoint} prev @param {object} update
 * @param {{ now?: number }} [options] @returns {import("../types/types.js").SyncCheckpoint}
 */
export function advanceCheckpoint(prev, update, options = {}) {
  const base = prev ?? { totalOperations: update.totalOperations ?? 0, completedOperations: 0, cursor: 0, conflicts: 0, merges: 0, pendingOperations: 0, replicaDrift: 0 };
  return {
    totalOperations: Math.max(base.totalOperations ?? 0, update.totalOperations ?? 0),
    completedOperations: Math.max(base.completedOperations ?? 0, update.completedOperations ?? 0),
    cursor: Math.max(base.cursor ?? 0, update.cursor ?? update.completedOperations ?? 0),
    conflicts: Math.max(base.conflicts ?? 0, update.conflicts ?? 0),
    merges: Math.max(base.merges ?? 0, update.merges ?? 0),
    pendingOperations: update.pendingOperations ?? base.pendingOperations ?? 0,
    replicaDrift: update.replicaDrift ?? base.replicaDrift ?? 0,
    checkpointAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

/**
 * Compute the resume plan from a checkpoint (which operations remain). Pure — never mutates. @returns
 * {{ resumable: boolean, fromCursor: number, remaining: number, totalOperations: number, plannedAt: string }}
 */
export function planResume(checkpoint, options = {}) {
  const total = checkpoint?.totalOperations ?? 0;
  const cursor = Math.max(0, Math.min(checkpoint?.cursor ?? checkpoint?.completedOperations ?? 0, total));
  const remaining = Math.max(0, total - cursor);
  return { resumable: remaining > 0, fromCursor: cursor, remaining, totalOperations: total, plannedAt: new Date(options.now ?? Date.now()).toISOString() };
}

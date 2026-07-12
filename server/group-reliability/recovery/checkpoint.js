/**
 * @module group-reliability/recovery/checkpoint
 *
 * **Group-operation checkpoint helpers.** A group operation's resumable progress is a small monotonic
 * record — how many targets (fan-out legs / sync ops / rekey distributions) completed, the resume
 * cursor, failed/pending/retried counts, and any backlog drift. Advancing it never regresses (a late or
 * duplicate report can't rewind progress), so a resume re-runs only the remaining targets and
 * consistency is preserved.
 *
 * @security Counts only — no content, no keys. Pure functions.
 */

/**
 * Merge a fresh progress report into a checkpoint (monotonic — never goes backwards for cumulative
 * fields). Pure; returns a NEW checkpoint. @param {import("../types/types.js").GroupCheckpoint} prev
 * @param {object} update @param {{ now?: number }} [options] @returns {import("../types/types.js").GroupCheckpoint}
 */
export function advanceCheckpoint(prev, update, options = {}) {
  const base = prev ?? { totalTargets: update.totalTargets ?? 0, completedTargets: 0, cursor: 0, failedTargets: 0, pendingTargets: 0, retriedTargets: 0, drift: 0 };
  return {
    totalTargets: Math.max(base.totalTargets ?? 0, update.totalTargets ?? 0),
    completedTargets: Math.max(base.completedTargets ?? 0, update.completedTargets ?? 0),
    cursor: Math.max(base.cursor ?? 0, update.cursor ?? update.completedTargets ?? 0),
    // failed/pending are the LATEST reported snapshot (they can go down as retries succeed).
    failedTargets: update.failedTargets ?? base.failedTargets ?? 0,
    pendingTargets: update.pendingTargets ?? base.pendingTargets ?? 0,
    retriedTargets: Math.max(base.retriedTargets ?? 0, update.retriedTargets ?? 0),
    drift: update.drift ?? base.drift ?? 0,
    checkpointAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

/**
 * Compute the resume plan from a checkpoint (which targets remain). Pure — never mutates. @returns
 * {{ resumable: boolean, fromCursor: number, remaining: number, totalTargets: number, plannedAt: string }}
 */
export function planResume(checkpoint, options = {}) {
  const total = checkpoint?.totalTargets ?? 0;
  const cursor = Math.max(0, Math.min(checkpoint?.cursor ?? checkpoint?.completedTargets ?? 0, total));
  const remaining = Math.max(0, total - cursor);
  return { resumable: remaining > 0, fromCursor: cursor, remaining, totalTargets: total, plannedAt: new Date(options.now ?? Date.now()).toISOString() };
}

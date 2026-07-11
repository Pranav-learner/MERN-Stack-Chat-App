/**
 * @module synchronization/queue
 *
 * The **Synchronization Queue** — an in-memory, priority-ordered queue of a session's pending sync
 * operations, with a retry sub-queue for failed operations. It orders by category priority (then batch
 * index) so a device receives the most-useful state first, supports pause / resume / cancel, and is
 * rebuildable from a persisted plan + cursor (so it is a fast index, not the source of truth).
 *
 * @security Holds operation records (entity refs + versions) — never content.
 *
 * @evolution A future Sprint 2 conflict-resolution step plugs in via the inert `onConflict` hook (a
 * chance to rewrite/skip an operation before it is dispensed). Sprint 1 never invokes it.
 */

import { DEFAULT_MAX_OP_RETRIES, SyncOperationState } from "../types/types.js";

export class SyncQueue {
  /** @param {{ maxRetries?: number, onConflict?: Function }} [options] */
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_OP_RETRIES;
    this.onConflict = options.onConflict ?? null; // FUTURE Sprint 2 seam (inert)
    /** @type {Map<string, object>} opId -> operation */
    this._ops = new Map();
    this._paused = false;
  }

  /**
   * Load a plan's operations, marking the first `cursor` operations as already APPLIED (so the queue
   * holds the FULL plan and applied-counts stay correct across a pause/resume — the resume cursor is
   * the number of completed operations, not a slice offset). Idempotent per opId.
   */
  loadFromPlan(plan, cursor = 0) {
    (plan.operations ?? []).forEach((op, i) => this.enqueue(i < cursor ? { ...op, state: SyncOperationState.APPLIED } : op));
    return this.size;
  }

  /** Enqueue an operation (idempotent by opId). @returns {boolean} whether it was added */
  enqueue(op) {
    if (this._ops.has(op.opId)) return false;
    this._ops.set(op.opId, { ...op, state: op.state ?? SyncOperationState.PENDING, retryCount: op.retryCount ?? 0 });
    return true;
  }

  get isPaused() {
    return this._paused;
  }
  pause() {
    this._paused = true;
  }
  resume() {
    this._paused = false;
  }

  /** Total queued operations (any non-terminal state). */
  get size() {
    let n = 0;
    for (const op of this._ops.values()) if (op.state === SyncOperationState.PENDING || op.state === SyncOperationState.IN_PROGRESS || op.state === SyncOperationState.FAILED) n++;
    return n;
  }

  /** Count of operations awaiting dispatch (pending or retry-ready). */
  get pendingCount() {
    let n = 0;
    for (const op of this._ops.values()) if (this._dispatchable(op)) n++;
    return n;
  }

  /**
   * Dequeue up to `max` operations to hand to the client (highest priority, then batch order). Marks
   * them IN_PROGRESS. Returns nothing while paused. @returns {object[]}
   */
  dequeue(max = Infinity) {
    if (this._paused) return [];
    const ready = [...this._ops.values()].filter((op) => this._dispatchable(op)).sort(compareOps);
    const out = [];
    for (const op of ready) {
      if (out.length >= max) break;
      op.state = SyncOperationState.IN_PROGRESS;
      out.push({ ...op });
    }
    return out;
  }

  /** Peek the next dispatchable operations without dispensing them. */
  peek(max = Infinity) {
    const ready = [...this._ops.values()].filter((op) => this._dispatchable(op)).sort(compareOps);
    return ready.slice(0, max === Infinity ? undefined : max).map((op) => ({ ...op }));
  }

  /** Mark an operation applied (terminal success). Idempotent — returns false if already applied. @returns {boolean} */
  markApplied(opId) {
    const op = this._ops.get(opId);
    if (!op || op.state === SyncOperationState.APPLIED) return false;
    op.state = SyncOperationState.APPLIED;
    return true;
  }

  /** Mark an operation failed → retry queue (until maxRetries, then permanently FAILED). @returns {"retry"|"exhausted"|"unknown"} */
  markFailed(opId) {
    const op = this._ops.get(opId);
    if (!op) return "unknown";
    op.retryCount = (op.retryCount ?? 0) + 1;
    if (op.retryCount > this.maxRetries) {
      op.state = SyncOperationState.FAILED;
      op._exhausted = true;
      return "exhausted";
    }
    op.state = SyncOperationState.FAILED;
    return "retry";
  }

  /** Whether every operation reached a terminal success (all applied/skipped). */
  get isComplete() {
    for (const op of this._ops.values()) if (op.state !== SyncOperationState.APPLIED && op.state !== SyncOperationState.SKIPPED) return false;
    return true;
  }

  /** How many operations are applied. */
  get appliedCount() {
    let n = 0;
    for (const op of this._ops.values()) if (op.state === SyncOperationState.APPLIED) n++;
    return n;
  }

  /** Total items across applied operations (for progress accounting). */
  get appliedItemCount() {
    let n = 0;
    for (const op of this._ops.values()) if (op.state === SyncOperationState.APPLIED) n += op.itemCount ?? 0;
    return n;
  }

  /** Whether any operation has permanently exhausted its retries. */
  get hasExhausted() {
    for (const op of this._ops.values()) if (op._exhausted) return true;
    return false;
  }

  clear() {
    this._ops.clear();
  }

  snapshot() {
    const byState = {};
    for (const op of this._ops.values()) byState[op.state] = (byState[op.state] ?? 0) + 1;
    return { total: this._ops.size, applied: this.appliedCount, pending: this.pendingCount, paused: this._paused, byState };
  }

  /** @private a dispatchable op = pending, or failed-but-retryable. */
  _dispatchable(op) {
    if (op.state === SyncOperationState.PENDING) return true;
    if (op.state === SyncOperationState.FAILED && !op._exhausted) return true;
    return false;
  }
}

/** Compare two operations for dispatch order (priority desc, then category asc, then batch asc). */
function compareOps(a, b) {
  if ((b.priority ?? 0) !== (a.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  return (a.batchIndex ?? 0) - (b.batchIndex ?? 0);
}

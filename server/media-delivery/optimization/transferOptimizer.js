/**
 * @module media-delivery/optimization
 *
 * **Transfer optimization** — a priority scheduler over media transfer tasks: transfer PRIORITIES
 * (high / normal / low / prefetch), a bounded PARALLEL-transfer slot count, queue optimization
 * (priority + age ordering, so a low-priority task can't starve forever), PREFETCH metadata, and
 * BANDWIDTH-usage metrics. It decides WHICH transfers run now; the engine executes them. An
 * ADAPTIVE-BUFFER placeholder hook is the seam for a future bandwidth-aware policy.
 *
 * @security The scheduler reasons over ids + priorities + byte counts ONLY — never ciphertext or keys.
 *
 * @performance O(log n) enqueue / O(n) schedule per tick over the pending set; parallel slots bound
 * concurrency so large-media transfers don't exhaust memory/CPU.
 */

import { TransferPriority, PRIORITY_WEIGHT, DEFAULT_PARALLEL_TRANSFERS } from "../types/types.js";

export class TransferScheduler {
  /** @param {{ parallel?: number, clock?: () => number }} [options] */
  constructor(options = {}) {
    this.parallel = options.parallel ?? DEFAULT_PARALLEL_TRANSFERS;
    this.clock = options.clock ?? (() => Date.now());
    this._pending = new Map(); // transferId → task
    this._running = new Set(); // transferId
    this._bandwidth = { bytes: 0, windowStart: this.clock(), samples: [] };
    this._optimizations = 0;
  }

  /** Enqueue a transfer task. @param {{ transferId, priority?, bytesTotal?, mediaId?, enqueuedAt? }} task */
  enqueue(task) {
    this._pending.set(String(task.transferId), { ...task, priority: task.priority ?? TransferPriority.NORMAL, enqueuedAt: task.enqueuedAt ?? this.clock() });
    return this;
  }

  /** Remove a task (completed/cancelled). */
  remove(transferId) {
    this._pending.delete(String(transferId));
    this._running.delete(String(transferId));
  }

  /**
   * Schedule the next batch to run: fills free parallel slots with the highest-priority pending tasks
   * (ties broken by age → no starvation). Returns the transfer ids that should start now. @returns {string[]}
   */
  schedule() {
    const free = Math.max(0, this.parallel - this._running.size);
    if (free === 0 || this._pending.size === 0) return [];
    const ordered = [...this._pending.values()].sort((a, b) => {
      const pd = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      return pd !== 0 ? pd : a.enqueuedAt - b.enqueuedAt; // older first within a priority
    });
    const picked = ordered.slice(0, free).map((t) => String(t.transferId));
    for (const id of picked) {
      this._running.add(id);
      this._pending.delete(id);
    }
    if (picked.length) this._optimizations += 1;
    return picked;
  }

  /** Mark a running transfer done (frees a slot). */
  complete(transferId) {
    this._running.delete(String(transferId));
  }

  /** Record delivered bytes for bandwidth metrics. */
  recordBytes(bytes) {
    this._bandwidth.bytes += bytes ?? 0;
    this._bandwidth.samples.push({ at: this.clock(), bytes: bytes ?? 0 });
    if (this._bandwidth.samples.length > 1000) this._bandwidth.samples.shift();
  }

  /** Bandwidth usage metrics (bytes/sec over the sample window). */
  bandwidth() {
    const now = this.clock();
    const windowMs = Math.max(1, now - this._bandwidth.windowStart);
    const recent = this._bandwidth.samples.filter((s) => s.at >= now - 10_000);
    const recentBytes = recent.reduce((a, s) => a + s.bytes, 0);
    return {
      totalBytes: this._bandwidth.bytes,
      bytesPerSec: Math.round((this._bandwidth.bytes / windowMs) * 1000),
      recentBytesPerSec: Math.round(recentBytes / 10),
      samples: recent.length,
    };
  }

  /** Build prefetch metadata for a set of candidate media (mark them prefetch-priority tasks). */
  prefetchPlan(candidates = []) {
    return candidates.map((mediaId) => ({ mediaId: String(mediaId), priority: TransferPriority.PREFETCH, reason: "prefetch" }));
  }

  /** Scheduler diagnostics. */
  stats() {
    const byPriority = {};
    for (const t of this._pending.values()) byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    return { pending: this._pending.size, running: this._running.size, parallel: this.parallel, optimizations: this._optimizations, byPriority, bandwidth: this.bandwidth() };
  }

  /** ADAPTIVE placeholder — a future policy resizes `parallel` from bandwidth signals. Inert this sprint. */
  adaptParallelism() {
    return this.parallel;
  }
}

export { TransferPriority };

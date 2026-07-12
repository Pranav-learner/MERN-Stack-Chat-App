/**
 * @module fabric-reliability/retry/bulkhead
 *
 * **Bulkhead isolation** (STEP 5) — caps the concurrency of one COMPARTMENT (e.g. media operations vs
 * control signalling) so a flood of one kind of work cannot exhaust the shared execution capacity and take
 * the whole Fabric down. Excess calls queue up to `maxQueue`; beyond that they are rejected fast with a
 * {@link BulkheadFullError} (graceful shedding rather than unbounded memory growth). Each compartment is
 * independent, so a saturated media compartment never blocks control signalling.
 *
 * @security Reasons over concurrency counts only. No content.
 */

import { DEFAULT_BULKHEAD, ReliabilityEventType } from "../types/types.js";
import { BulkheadFullError } from "../errors.js";

export class Bulkhead {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name] @param {number} [opts.maxConcurrent] @param {number} [opts.maxQueue]
   * @param {import("../events/events.js").FabricReliabilityEventBus} [opts.events]
   */
  constructor(opts = {}) {
    this.name = opts.name ?? "default";
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_BULKHEAD.maxConcurrent;
    this.maxQueue = opts.maxQueue ?? DEFAULT_BULKHEAD.maxQueue;
    this.events = opts.events ?? null;
    this._active = 0;
    this._queue = []; // { resolve, reject, fn }
    this._rejected = 0;
    this._peakActive = 0;
  }

  get active() {
    return this._active;
  }
  get queued() {
    return this._queue.length;
  }

  /**
   * Run `fn` within the compartment. Runs immediately if a slot is free, else queues; rejects with
   * {@link BulkheadFullError} when both concurrency + queue are saturated.
   * @param {() => Promise<any>} fn @returns {Promise<any>}
   */
  run(fn) {
    if (this._active < this.maxConcurrent) return this._invoke(fn);
    if (this._queue.length >= this.maxQueue) {
      this._rejected++;
      this.events?.emit(ReliabilityEventType.BULKHEAD_REJECTED, { name: this.name, active: this._active, queued: this._queue.length });
      return Promise.reject(new BulkheadFullError(`Bulkhead "${this.name}" is full`, { details: { name: this.name, maxConcurrent: this.maxConcurrent, maxQueue: this.maxQueue } }));
    }
    return new Promise((resolve, reject) => this._queue.push({ resolve, reject, fn }));
  }

  async _invoke(fn) {
    this._active++;
    if (this._active > this._peakActive) this._peakActive = this._active;
    try {
      return await fn();
    } finally {
      this._active--;
      this._drain();
    }
  }

  _drain() {
    if (this._active >= this.maxConcurrent) return;
    const next = this._queue.shift();
    if (!next) return;
    this._invoke(next.fn).then(next.resolve, next.reject);
  }

  stats() {
    return { name: this.name, active: this._active, queued: this._queue.length, maxConcurrent: this.maxConcurrent, maxQueue: this.maxQueue, rejected: this._rejected, peakActive: this._peakActive };
  }
}

/** A registry of bulkheads keyed by compartment name, created lazily with a shared default config. */
export class BulkheadRegistry {
  constructor(opts = {}) {
    this.defaults = opts.defaults ?? {};
    this.events = opts.events ?? null;
    this._byName = new Map();
  }

  get(name, overrides = {}) {
    let b = this._byName.get(name);
    if (!b) {
      b = new Bulkhead({ name, events: this.events, ...this.defaults, ...overrides });
      this._byName.set(name, b);
    }
    return b;
  }

  stats() {
    return [...this._byName.values()].map((b) => b.stats());
  }
}

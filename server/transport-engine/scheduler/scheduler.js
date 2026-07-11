/**
 * @module transport-engine/scheduler
 *
 * **Chunk transmission scheduling.** Given the set of ready chunks (one candidate per eligible
 * transfer — eligibility = has a pending chunk AND flow-control room), the scheduler picks the next
 * chunk to transmit by effective priority weight (with aging so nothing starves). The engine feeds
 * candidates in the multiplexer's round-robin order, so equal-weight transfers rotate fairly.
 *
 * Also provides {@link TransportPumpScheduler}: a thin timer that periodically drives the engine's
 * `pump()` (send within the window) + `sweepTimeouts()` (retransmit / expire). The timer is `unref`'d
 * so it never keeps the process alive; tests drive `tick()` directly.
 */

import { compareCandidates } from "../priorities/priority.js";

export class TransferScheduler {
  /** @param {object} [options] @param {number} [options.agingMs] starvation-prevention aging window */
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Pick the single best candidate to transmit next (highest effective weight; earliest on ties, which
   * preserves the caller's fairness ordering). @param {object[]} candidates @param {number} now
   * @returns {object|null}
   */
  pick(candidates, now) {
    let best = null;
    for (const c of candidates) {
      if (best === null || compareCandidates(c, best, now, this.options) < 0) best = c;
    }
    return best;
  }

  /** Return candidates ordered best-first (stable). @param {object[]} candidates @param {number} now */
  order(candidates, now) {
    return [...candidates].sort((a, b) => compareCandidates(a, b, now, this.options));
  }
}

/**
 * A timer that periodically pumps the engine. Production uses `start()`; tests use `tick()`.
 */
export class TransportPumpScheduler {
  /**
   * @param {object} deps @param {{ pump: () => Promise<any>, sweepTimeouts: (now?: number) => Promise<any>, clock?: () => number }} deps.engine
   * @param {number} [deps.intervalMs] @param {(e: unknown) => void} [deps.onError]
   */
  constructor(deps) {
    if (!deps?.engine) throw new Error("TransportPumpScheduler requires { engine }");
    this.engine = deps.engine;
    this.intervalMs = deps.intervalMs ?? 250;
    this.onError = deps.onError ?? ((e) => console.error("[transport-engine] pump failed:", e?.message ?? e));
    this._timer = null;
    this._running = false;
    this._stats = { ticks: 0, lastTickAt: null };
  }

  get isRunning() {
    return this._running;
  }
  stats() {
    return { ...this._stats, intervalMs: this.intervalMs, running: this._running };
  }

  /** Run one pump + timeout sweep. @param {number} [now] */
  async tick(now) {
    try {
      await this.engine.pump();
      const res = await this.engine.sweepTimeouts(now);
      this._stats.ticks++;
      this._stats.lastTickAt = new Date(now ?? (this.engine.clock?.() ?? Date.now())).toISOString();
      return res;
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }
}

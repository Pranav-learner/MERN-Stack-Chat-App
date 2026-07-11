/**
 * @module network-reliability/heartbeat
 *
 * The **Heartbeat Monitor** — the failure-detection scheduler for active connections. Clients beat
 * to keep a connection alive; this monitor periodically sweeps for connections whose heartbeats have
 * stopped past the timeout and asks the manager to recover them (a `CONNECTION_TIMEOUT` /
 * `UNEXPECTED_DISCONNECT` trigger). It holds no connection state itself.
 *
 * @distributed With multiple instances behind a shared store, running the monitor on each is safe —
 * `sweepHeartbeats` is idempotent (a connection already recovering/closed is skipped). For large
 * fleets, shard sweeps by connection-id range without changing this interface.
 *
 * @example
 * ```js
 * const monitor = new HeartbeatMonitor({ manager, intervalMs: 5000 });
 * monitor.start(); // periodic sweeps (unref'd)
 * ```
 */

import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../types/types.js";

export class HeartbeatMonitor {
  /**
   * @param {object} deps
   * @param {import("../manager/networkReliabilityManager.js").NetworkReliabilityManager} deps.manager
   * @param {number} [deps.intervalMs] @param {(error:unknown)=>void} [deps.onError]
   */
  constructor(deps) {
    if (!deps || !deps.manager) throw new Error("HeartbeatMonitor requires { manager }");
    this.manager = deps.manager;
    this.intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.onError = deps.onError ?? ((error) => console.error("[reliability] heartbeat sweep failed:", error?.message ?? error));
    this._timer = null;
    this._running = false;
    this._stats = { sweeps: 0, timedOut: 0, recovered: 0, errors: 0, lastSweepAt: null };
  }

  /** @returns {boolean} */
  get isRunning() {
    return this._running;
  }

  /** Monitor statistics snapshot. */
  stats() {
    return { ...this._stats, intervalMs: this.intervalMs, running: this._running };
  }

  /**
   * Run one sweep now (also the tests' entry point). Safe under concurrency.
   * @param {number} [now] @returns {Promise<{ timedOut: number, recovered: number }>}
   */
  async tick(now) {
    try {
      const result = await this.manager.sweepHeartbeats(now);
      this._stats.sweeps++;
      this._stats.timedOut += result.timedOut ?? 0;
      this._stats.recovered += result.recovered ?? 0;
      this._stats.lastSweepAt = new Date(now ?? this.manager.clock()).toISOString();
      return result;
    } catch (error) {
      this._stats.errors++;
      this.onError(error);
      return { timedOut: 0, recovered: 0 };
    }
  }

  /** Start periodic sweeps. Idempotent; the timer is `unref`'d. */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  /** Stop periodic sweeps. Idempotent. */
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }
}

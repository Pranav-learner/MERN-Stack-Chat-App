/**
 * @module presence/heartbeat
 *
 * The **Heartbeat Monitor** — the failure-detection scheduler for the Presence Service. Clients
 * send heartbeats to keep a device's presence alive; this monitor periodically sweeps the store
 * for devices whose heartbeats have stopped past the timeout and expires them (via
 * {@link module:presence/manager.PresenceManager#sweepExpired}), emitting `HEARTBEAT_MISSED` +
 * `EXPIRED`.
 *
 * The monitor is a thin, injectable scheduler over the manager: in production it runs on a
 * timer; in tests it is driven manually with a controllable clock via {@link tick}. It holds no
 * presence state itself.
 *
 * @distributed With multiple server instances behind a shared store, running the monitor on
 * each instance is SAFE — `sweepExpired` is idempotent (a record already moved by another
 * instance's sweep or by a heartbeat is skipped). For very large fleets, a future deployment can
 * elect a single sweeper or shard sweeps by user-id range; the monitor's interface does not
 * change.
 *
 * @example
 * ```js
 * const monitor = new HeartbeatMonitor({ manager, intervalMs: 10_000 });
 * monitor.start();          // periodic sweeps (unref'd, won't hold the process open)
 * // ... later ...
 * monitor.stop();
 * ```
 */

import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../types/types.js";

export class HeartbeatMonitor {
  /**
   * @param {object} deps
   * @param {import("../manager/presenceManager.js").PresenceManager} deps.manager
   * @param {number} [deps.intervalMs] sweep cadence
   * @param {(error: unknown) => void} [deps.onError] error sink for background sweeps
   */
  constructor(deps) {
    if (!deps || !deps.manager) throw new Error("HeartbeatMonitor requires { manager }");
    this.manager = deps.manager;
    this.intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.onError = deps.onError ?? ((error) => console.error("[presence] heartbeat sweep failed:", error?.message ?? error));
    this._timer = null;
    this._running = false;
    this._stats = { sweeps: 0, expired: 0, cachePruned: 0, lastSweepAt: null, errors: 0 };
  }

  /** Whether the monitor's background timer is active. @returns {boolean} */
  get isRunning() {
    return this._running;
  }

  /** Monitor statistics snapshot (observability). */
  stats() {
    return { ...this._stats, intervalMs: this.intervalMs, running: this._running };
  }

  /**
   * Run a single sweep now (also the unit tests' entry point). Safe to call concurrently — the
   * underlying `sweepExpired` is idempotent.
   * @param {number} [now] epoch ms (defaults to the manager's clock)
   * @returns {Promise<{ expired: number, cachePruned: number }>}
   */
  async tick(now) {
    try {
      const result = await this.manager.sweepExpired(now);
      this._stats.sweeps++;
      this._stats.expired += result.expired;
      this._stats.cachePruned += result.cachePruned;
      this._stats.lastSweepAt = new Date(now ?? this.manager.clock()).toISOString();
      return result;
    } catch (error) {
      this._stats.errors++;
      this.onError(error);
      return { expired: 0, cachePruned: 0 };
    }
  }

  /**
   * Start periodic sweeps. Idempotent (a second `start()` is a no-op). The timer is `unref`'d so
   * it never keeps the Node process alive on its own.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => {
      // Fire-and-forget; `tick` swallows + records errors so the interval never throws.
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

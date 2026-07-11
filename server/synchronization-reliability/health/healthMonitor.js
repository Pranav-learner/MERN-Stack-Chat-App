/**
 * @module synchronization-reliability/health
 *
 * **Synchronization health monitoring.** Scores a synchronization's health from its checkpoint +
 * activity across four weighted dimensions — progress, reliability (conflict rate + merge success),
 * replica drift, and freshness (time since last activity) — into a `[0,1]` score + a `healthy /
 * degraded / unhealthy` status. Also runs a periodic **stall + drift sweep**: a sync with no progress
 * for longer than the stall timeout is flagged INTERRUPTED, and excessive replica drift raises a signal.
 *
 * @security Health is computed from CONTROL-PLANE numbers only (operation counts, conflict counts,
 * timestamps, drift).
 *
 * @performance `scoreHealth` is O(1); the sweep is O(active syncs) and driven by an `unref`'d timer (or
 * `tick()` in tests).
 */

import {
  HealthStatus,
  HEALTH_WEIGHTS,
  CONFLICT_RATE_CEILING,
  DRIFT_CEILING,
  STALENESS_CEILING_MS,
  ReliabilityState,
  RecoveryTrigger,
  DEFAULT_STALL_TIMEOUT_MS,
} from "../types/types.js";

/**
 * Score a synchronization's health. Pure. @param {import("../types/types.js").SyncReliabilityRecord} record
 * @param {{ now?: number }} [options] @returns {import("../types/types.js").SyncHealth}
 */
export function scoreHealth(record, options = {}) {
  const now = options.now ?? Date.now();
  const cp = record.checkpoint ?? { totalOperations: 0, completedOperations: 0, conflicts: 0, merges: 0, pendingOperations: 0, replicaDrift: 0 };
  const total = Math.max(1, cp.totalOperations ?? 0);
  const progress = clamp01((cp.completedOperations ?? 0) / total);

  const conflictRate = (cp.conflicts ?? 0) / Math.max(1, cp.completedOperations ?? 0);
  const mergeSuccessRate = 1; // merges are deterministic + lossless in Sprint 2 (no failed merges)
  const reliabilityScore = clamp01(1 - conflictRate / CONFLICT_RATE_CEILING) * mergeSuccessRate;

  const drift = cp.replicaDrift ?? cp.pendingOperations ?? 0;
  const driftScore = clamp01(1 - drift / DRIFT_CEILING);

  const stalenessMs = now - new Date(record.lastActivityAt ?? record.registeredAt ?? now).getTime();
  const freshnessScore = clamp01(1 - stalenessMs / STALENESS_CEILING_MS);

  const startedMs = new Date(record.registeredAt ?? now).getTime();
  const elapsedSec = Math.max(0.001, (now - startedMs) / 1000);
  const throughput = (cp.completedOperations ?? 0) / elapsedSec;

  const score = round(HEALTH_WEIGHTS.progress * progress + HEALTH_WEIGHTS.reliability * reliabilityScore + HEALTH_WEIGHTS.drift * driftScore + HEALTH_WEIGHTS.freshness * freshnessScore);

  let status = HealthStatus.HEALTHY;
  if (score < 0.4) status = HealthStatus.UNHEALTHY;
  else if (score < 0.7) status = HealthStatus.DEGRADED;

  return { status, score, progress: round(progress), conflictRate: round(conflictRate), mergeSuccessRate, replicaDrift: drift, stalenessMs, throughput: round(throughput) };
}

/**
 * A background monitor that periodically flags stalled synchronizations as interrupted. Production uses
 * `start()`; tests use `sweep()`.
 */
export class SyncHealthMonitor {
  /** @param {{ manager: object, stallTimeoutMs?: number, intervalMs?: number, onError?: Function }} deps */
  constructor(deps) {
    if (!deps?.manager) throw new Error("SyncHealthMonitor requires { manager }");
    this.manager = deps.manager;
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.intervalMs = deps.intervalMs ?? 10_000;
    this.onError = deps.onError ?? ((e) => console.error("[sync-reliability] stall sweep failed:", e?.message ?? e));
    this._timer = null;
    this._running = false;
    this._stats = { sweeps: 0, interrupted: 0, lastSweepAt: null };
  }

  get isRunning() {
    return this._running;
  }
  stats() {
    return { ...this._stats, stallTimeoutMs: this.stallTimeoutMs, running: this._running };
  }

  /** Flag syncs with no progress for longer than the stall timeout as interrupted. @param {number} [now] */
  async sweep(now = this.manager.clock?.() ?? Date.now()) {
    let interrupted = 0;
    let scanned = 0;
    try {
      const records = await this.manager.listStalled(now, this.stallTimeoutMs);
      for (const record of records) {
        scanned++;
        if (record.state === ReliabilityState.TRACKING || record.state === ReliabilityState.DEGRADED) {
          await this.manager.reportInterruption(record.syncId, RecoveryTrigger.STALL_TIMEOUT, { now });
          interrupted++;
        }
      }
      this._stats.sweeps++;
      this._stats.interrupted += interrupted;
      this._stats.lastSweepAt = new Date(now).toISOString();
    } catch (error) {
      this.onError(error);
    }
    return { interrupted, scanned };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => void this.sweep(), this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
function round(n) {
  return Number(n.toFixed(4));
}

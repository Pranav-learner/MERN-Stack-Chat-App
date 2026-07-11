/**
 * @module transport-reliability/monitoring/health
 *
 * **Transfer health monitoring.** Scores a transfer's health from its checkpoint + activity across four
 * weighted dimensions — progress, throughput, reliability (retry/failure rate), and freshness (time
 * since last activity) — into a `[0,1]` score + a `healthy | degraded | unhealthy` status. Also runs a
 * periodic **stall sweep**: a transfer with no progress for longer than the stall timeout is flagged
 * INTERRUPTED so the manager can recover it.
 *
 * @security Health is computed from CONTROL-PLANE numbers only (chunk counts, byte totals, timestamps).
 *
 * @performance `scoreHealth` is O(1); the sweep is O(active transfers) and driven by an `unref`'d timer
 * (or `tick()` in tests) so it never keeps the process alive.
 */

import {
  HealthStatus,
  HEALTH_WEIGHTS,
  RETRY_RATE_CEILING,
  STALENESS_CEILING_MS,
  ReliabilityState,
  RecoveryTrigger,
  DEFAULT_STALL_TIMEOUT_MS,
} from "../types/types.js";

/** Default healthy-throughput reference (bytes/sec): at/above this the throughput dimension scores 1. */
const DEFAULT_REFERENCE_BPS = 32 * 1024;

/**
 * Score a transfer's health. Pure. @param {import("../types/types.js").TransferReliabilityRecord} record
 * @param {{ now?: number, referenceBps?: number }} [options] @returns {import("../types/types.js").TransferHealth}
 */
export function scoreHealth(record, options = {}) {
  const now = options.now ?? Date.now();
  const referenceBps = options.referenceBps ?? DEFAULT_REFERENCE_BPS;
  const cp = record.checkpoint ?? { totalChunks: 1, chunksAcked: 0, bytesTransferred: 0, retryCount: 0, outstanding: 0 };
  const total = Math.max(1, cp.totalChunks ?? 1);
  const progress = clamp01((cp.chunksAcked ?? 0) / total);

  const startedMs = new Date(record.registeredAt ?? now).getTime();
  const elapsedSec = Math.max(0.001, (now - startedMs) / 1000);
  const throughputBytesPerSec = (cp.bytesTransferred ?? 0) / elapsedSec;
  const throughputScore = clamp01(throughputBytesPerSec / referenceBps);

  const retryRate = (cp.retryCount ?? 0) / Math.max(1, cp.chunksAcked ?? 0);
  const failureRate = record.metadata?.failureRate ?? 0;
  const reliabilityScore = clamp01(1 - retryRate / RETRY_RATE_CEILING) * clamp01(1 - failureRate);

  const stalenessMs = now - new Date(record.lastActivityAt ?? record.registeredAt ?? now).getTime();
  const freshnessScore = clamp01(1 - stalenessMs / STALENESS_CEILING_MS);

  const score = round(
    HEALTH_WEIGHTS.progress * progress +
      HEALTH_WEIGHTS.throughput * throughputScore +
      HEALTH_WEIGHTS.reliability * reliabilityScore +
      HEALTH_WEIGHTS.freshness * freshnessScore,
  );

  let status = HealthStatus.HEALTHY;
  if (score < 0.4) status = HealthStatus.UNHEALTHY;
  else if (score < 0.7) status = HealthStatus.DEGRADED;

  return { status, score, throughputBytesPerSec: round(throughputBytesPerSec), retryRate: round(retryRate), failureRate: round(failureRate), outstanding: cp.outstanding ?? 0, stalenessMs, progress: round(progress) };
}

/**
 * A background monitor that periodically flags stalled transfers as interrupted. Production uses
 * `start()`; tests use `sweep()`.
 */
export class TransferHealthMonitor {
  /** @param {{ manager: object, stallTimeoutMs?: number, intervalMs?: number, onError?: Function }} deps */
  constructor(deps) {
    if (!deps?.manager) throw new Error("TransferHealthMonitor requires { manager }");
    this.manager = deps.manager;
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.intervalMs = deps.intervalMs ?? 5_000;
    this.onError = deps.onError ?? ((e) => console.error("[transport-reliability] stall sweep failed:", e?.message ?? e));
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

  /**
   * Flag transfers with no progress for longer than the stall timeout as interrupted. @param {number} [now]
   * @returns {Promise<{ interrupted: number, scanned: number }>}
   */
  async sweep(now = this.manager.clock?.() ?? Date.now()) {
    let interrupted = 0;
    let scanned = 0;
    try {
      const records = await this.manager.listStalled(now, this.stallTimeoutMs);
      for (const record of records) {
        scanned++;
        if (record.state === ReliabilityState.TRACKING || record.state === ReliabilityState.DEGRADED) {
          await this.manager.reportInterruption(record.transferId, RecoveryTrigger.STALL_TIMEOUT, { now });
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

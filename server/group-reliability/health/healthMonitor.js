/**
 * @module group-reliability/health
 *
 * **Group-operation health monitoring.** Scores an operation's health from its checkpoint + activity
 * across four weighted dimensions — progress, reliability (fan-out/target failure rate), backlog
 * (pending targets / offline queue), and freshness (time since last activity) — into a `[0,1]` score +
 * a `healthy / degraded / unhealthy` status. Also runs a periodic **stall + backlog sweep**: an
 * operation with no progress for longer than the stall timeout is flagged INTERRUPTED, and excessive
 * backlog raises a signal.
 *
 * @security Health is computed from CONTROL-PLANE numbers only (target counts, failure counts,
 * timestamps, backlog).
 *
 * @performance `scoreHealth` is O(1); the sweep is O(active operations) and driven by an `unref`'d timer
 * (or `sweep()` in tests).
 */

import {
  HealthStatus,
  HEALTH_WEIGHTS,
  FAILURE_RATE_CEILING,
  BACKLOG_CEILING,
  STALENESS_CEILING_MS,
  ReliabilityState,
  RecoveryTrigger,
  DEFAULT_STALL_TIMEOUT_MS,
} from "../types/types.js";

/**
 * Score a group operation's health. Pure. @param {import("../types/types.js").GroupReliabilityRecord} record
 * @param {{ now?: number }} [options] @returns {import("../types/types.js").GroupHealth}
 */
export function scoreHealth(record, options = {}) {
  const now = options.now ?? Date.now();
  const cp = record.checkpoint ?? { totalTargets: 0, completedTargets: 0, failedTargets: 0, pendingTargets: 0, drift: 0 };
  const total = Math.max(1, cp.totalTargets ?? 0);
  const progress = clamp01((cp.completedTargets ?? 0) / total);

  const attempted = Math.max(1, (cp.completedTargets ?? 0) + (cp.failedTargets ?? 0));
  const failureRate = (cp.failedTargets ?? 0) / attempted;
  const reliabilityScore = clamp01(1 - failureRate / FAILURE_RATE_CEILING);

  const backlog = cp.pendingTargets ?? cp.drift ?? 0;
  const backlogScore = clamp01(1 - backlog / BACKLOG_CEILING);

  const stalenessMs = now - new Date(record.lastActivityAt ?? record.registeredAt ?? now).getTime();
  const freshnessScore = clamp01(1 - stalenessMs / STALENESS_CEILING_MS);

  const startedMs = new Date(record.registeredAt ?? now).getTime();
  const elapsedSec = Math.max(0.001, (now - startedMs) / 1000);
  const throughput = (cp.completedTargets ?? 0) / elapsedSec;

  const score = round(HEALTH_WEIGHTS.progress * progress + HEALTH_WEIGHTS.reliability * reliabilityScore + HEALTH_WEIGHTS.backlog * backlogScore + HEALTH_WEIGHTS.freshness * freshnessScore);

  let status = HealthStatus.HEALTHY;
  if (score < 0.4) status = HealthStatus.UNHEALTHY;
  else if (score < 0.7) status = HealthStatus.DEGRADED;

  return { status, score, progress: round(progress), failureRate: round(failureRate), pending: backlog, stalenessMs, throughput: round(throughput) };
}

/**
 * Aggregate the health of a whole GROUP from its operation records (group / fan-out / replica / sync /
 * key-rotation health + pending operations + recovery stats). Pure.
 * @param {import("../types/types.js").GroupReliabilityRecord[]} records @param {{ now?: number }} [options]
 */
export function scoreGroupHealth(records = [], options = {}) {
  const now = options.now ?? Date.now();
  const byType = {};
  let scoreSum = 0;
  let scored = 0;
  let pending = 0;
  let interrupted = 0;
  let recovering = 0;
  for (const record of records) {
    const h = scoreHealth(record, { now });
    scoreSum += h.score;
    scored += 1;
    pending += record.checkpoint?.pendingTargets ?? 0;
    if (record.state === ReliabilityState.INTERRUPTED) interrupted += 1;
    if (record.state === ReliabilityState.RECOVERING) recovering += 1;
    const t = record.operationType;
    byType[t] = byType[t] ?? { count: 0, scoreSum: 0 };
    byType[t].count += 1;
    byType[t].scoreSum += h.score;
  }
  const score = scored ? round(scoreSum / scored) : 1;
  let status = HealthStatus.HEALTHY;
  if (score < 0.4 || interrupted > scored / 2) status = HealthStatus.UNHEALTHY;
  else if (score < 0.7 || interrupted > 0) status = HealthStatus.DEGRADED;
  const perType = Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, { count: v.count, score: round(v.scoreSum / v.count) }]));
  return { status, score, operations: scored, pendingOperations: pending, interrupted, recovering, perType };
}

/**
 * A background monitor that periodically flags stalled group operations as interrupted. Production uses
 * `start()`; tests use `sweep()`.
 */
export class GroupHealthMonitor {
  /** @param {{ manager: object, stallTimeoutMs?: number, intervalMs?: number, onError?: Function }} deps */
  constructor(deps) {
    if (!deps?.manager) throw new Error("GroupHealthMonitor requires { manager }");
    this.manager = deps.manager;
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.intervalMs = deps.intervalMs ?? 10_000;
    this.onError = deps.onError ?? ((e) => console.error("[group-reliability] stall sweep failed:", e?.message ?? e));
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

  /** Flag operations with no progress for longer than the stall timeout as interrupted. @param {number} [now] */
  async sweep(now = this.manager.clock?.() ?? Date.now()) {
    let interrupted = 0;
    let scanned = 0;
    try {
      const records = await this.manager.listStalled(now, this.stallTimeoutMs);
      for (const record of records) {
        scanned++;
        if (record.state === ReliabilityState.TRACKING || record.state === ReliabilityState.DEGRADED) {
          await this.manager.reportInterruption(record.operationId, RecoveryTrigger.STALL_TIMEOUT, { now });
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

/**
 * @module synchronization-reliability/monitoring/metrics
 *
 * **Production metrics registry** for the synchronization layer. A dependency-free, in-process registry
 * of counters, gauges, and histograms, with `snapshot()`, a Prometheus text-exposition renderer, and an
 * OpenTelemetry export hook. Wire it into the reliability manager to record synchronization throughput +
 * latency, conflict rate, merge success rate, recovery success rate, resume + retry counts, replica
 * drift, pending operations, queue depth, concurrent syncs, and health score.
 *
 * @security Metrics are numeric aggregates + low-cardinality labels — NEVER content, per-replica ids as
 * labels, or key material.
 */

import { MetricType, Metric } from "../types/types.js";

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export class SyncMetrics {
  /** @param {{ clock?: () => number, buckets?: number[] }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this._buckets = options.buckets ?? DEFAULT_BUCKETS;
    this._scalars = new Map();
    this._histograms = new Map();
    this._exporters = [];
  }

  increment(name, n = 1, labels) {
    const k = this._key(name, labels);
    const cur = this._scalars.get(k) ?? { type: MetricType.COUNTER, value: 0 };
    cur.value += n;
    this._scalars.set(k, cur);
    return cur.value;
  }

  gauge(name, value, labels) {
    this._scalars.set(this._key(name, labels), { type: MetricType.GAUGE, value });
    return value;
  }

  observe(name, value, labels) {
    const k = this._key(name, labels);
    let h = this._histograms.get(k);
    if (!h) {
      h = { count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Map(this._buckets.map((b) => [b, 0])) };
      this._histograms.set(k, h);
    }
    h.count++;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
    for (const b of this._buckets) if (value <= b) h.buckets.set(b, h.buckets.get(b) + 1);
    return value;
  }

  /** Start a timer; returns `stop()` that observes elapsed ms into `name`. */
  startTimer(name, labels) {
    const start = this._clock();
    return () => this.observe(name, this._clock() - start, labels);
  }

  // === sync-specific recorders =============================================

  /** Record a completed/failed synchronization (total + success/failure) + its latency. */
  recordSync(success, latencyMs) {
    this.increment(Metric.SYNC_TOTAL);
    this.increment(success ? Metric.SYNC_SUCCESS : Metric.SYNC_FAILURE);
    if (Number.isFinite(latencyMs)) this.observe(Metric.SYNC_LATENCY, latencyMs);
    return this.syncSuccessRate();
  }

  /** Record a recovery outcome + time. */
  recordRecovery(success, timeMs) {
    this.increment(Metric.RECOVERY_TOTAL);
    this.increment(success ? Metric.RECOVERY_SUCCESS : Metric.RECOVERY_FAILURE);
    if (Number.isFinite(timeMs)) this.observe(Metric.RECOVERY_TIME, timeMs);
  }

  recordResume() {
    this.increment(Metric.RESUME_TOTAL);
  }
  recordRetry() {
    this.increment(Metric.RETRY_TOTAL);
  }

  /** Record conflicts + merges observed in a checkpoint (drives the conflict rate + merge success). */
  recordConflictsMerges(conflicts, merges) {
    if (conflicts) this.increment(Metric.CONFLICT_TOTAL, conflicts);
    if (merges) {
      this.increment(Metric.MERGE_TOTAL, merges);
      this.increment(Metric.MERGE_SUCCESS, merges);
    }
  }

  /** Record per-sync gauges (throughput, drift, pending, queue depth). */
  recordProgress({ throughput, replicaDrift, pendingOperations, queueDepth } = {}) {
    if (Number.isFinite(throughput)) this.observe(Metric.SYNC_THROUGHPUT, throughput);
    if (Number.isFinite(replicaDrift)) this.gauge(Metric.REPLICA_DRIFT, replicaDrift);
    if (Number.isFinite(pendingOperations)) this.gauge(Metric.PENDING_OPERATIONS, pendingOperations);
    if (Number.isFinite(queueDepth)) this.gauge(Metric.QUEUE_DEPTH, queueDepth);
  }

  syncSuccessRate() {
    const s = this._val(Metric.SYNC_SUCCESS);
    const f = this._val(Metric.SYNC_FAILURE);
    return s + f === 0 ? 1 : s / (s + f);
  }
  recoverySuccessRate() {
    const s = this._val(Metric.RECOVERY_SUCCESS);
    const f = this._val(Metric.RECOVERY_FAILURE);
    return s + f === 0 ? 1 : s / (s + f);
  }
  conflictRate() {
    const c = this._val(Metric.CONFLICT_TOTAL);
    const done = this._val(Metric.SYNC_SUCCESS) + this._val(Metric.SYNC_FAILURE);
    return done === 0 ? 0 : c / done;
  }

  // === export ==============================================================

  snapshot() {
    const counters = {};
    const gauges = {};
    for (const [k, v] of this._scalars) (v.type === MetricType.COUNTER ? counters : gauges)[k] = v.value;
    const histograms = {};
    for (const [k, h] of this._histograms) {
      histograms[k] = { count: h.count, sum: round(h.sum), avg: h.count ? round(h.sum / h.count) : 0, min: h.count ? round(h.min) : 0, max: h.count ? round(h.max) : 0 };
    }
    return { counters, gauges, histograms, syncSuccessRate: this.syncSuccessRate(), recoverySuccessRate: this.recoverySuccessRate(), conflictRate: round(this.conflictRate()) };
  }

  prometheus() {
    const lines = [];
    for (const [k, v] of this._scalars) {
      const { name, labels } = this._parse(k);
      lines.push(`# TYPE ${name} ${v.type === MetricType.COUNTER ? "counter" : "gauge"}`);
      lines.push(`${name}${labels} ${v.value}`);
    }
    for (const [k, h] of this._histograms) {
      const { name, labels } = this._parse(k);
      lines.push(`# TYPE ${name} histogram`);
      for (const b of this._buckets) lines.push(`${name}_bucket${this._withLe(labels, b)} ${h.buckets.get(b)}`);
      lines.push(`${name}_bucket${this._withLe(labels, "+Inf")} ${h.count}`);
      lines.push(`${name}_sum${labels} ${h.sum}`);
      lines.push(`${name}_count${labels} ${h.count}`);
    }
    return lines.join("\n") + "\n";
  }

  registerExporter(fn) {
    this._exporters.push(fn);
    return () => {
      this._exporters = this._exporters.filter((e) => e !== fn);
    };
  }

  exportMetrics() {
    const snap = this.snapshot();
    for (const fn of this._exporters) {
      try {
        fn(snap);
      } catch {
        /* an exporter failure must never break the sync path */
      }
    }
    return snap;
  }

  reset() {
    this._scalars.clear();
    this._histograms.clear();
  }

  _val(name, labels) {
    return this._scalars.get(this._key(name, labels))?.value ?? 0;
  }
  _key(name, labels) {
    if (!labels || Object.keys(labels).length === 0) return name;
    const l = Object.keys(labels).sort().map((key) => `${key}="${String(labels[key])}"`).join(",");
    return `${name}{${l}}`;
  }
  _parse(k) {
    const i = k.indexOf("{");
    return i === -1 ? { name: k, labels: "" } : { name: k.slice(0, i), labels: k.slice(i) };
  }
  _withLe(labels, le) {
    if (!labels) return `{le="${le}"}`;
    return `${labels.slice(0, -1)},le="${le}"}`;
  }
}

function round(n) {
  return Number(n.toFixed(4));
}

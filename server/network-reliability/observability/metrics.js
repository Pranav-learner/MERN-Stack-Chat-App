/**
 * @module network-reliability/observability
 *
 * **Production metrics registry** for the connectivity layer. A dependency-free, in-process registry
 * of counters, gauges, and histograms, with a `snapshot()`, a Prometheus text-exposition renderer,
 * and an OpenTelemetry export hook. Wire it into the reliability manager to record connection
 * success/failure rate, reconnect + recovery counts, recovery success, latency, health score, relay
 * usage, candidate-selection time, and recovery time.
 *
 * @security Metrics are numeric aggregates + low-cardinality labels — NEVER key material or per-
 * connection ids as labels.
 */

import { MetricType, Metric } from "../types/types.js";

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class ReliabilityMetrics {
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

  /** Start a timer; returns a `stop()` that observes the elapsed ms into `name`. */
  startTimer(name, labels) {
    const start = this._clock();
    return () => this.observe(name, this._clock() - start, labels);
  }

  // === connection-specific recorders =======================================

  /** Record a connection outcome (total + success/failure). @returns {number} success rate */
  recordConnection(success) {
    this.increment(Metric.CONNECTION_TOTAL);
    this.increment(success ? Metric.CONNECTION_SUCCESS : Metric.CONNECTION_FAILURE);
    return this.connectionSuccessRate();
  }

  /** Record a recovery outcome (total + success/failure) + the recovery time. */
  recordRecovery(success, timeMs) {
    this.increment(Metric.RECOVERY_TOTAL);
    this.increment(success ? Metric.RECOVERY_SUCCESS : Metric.RECOVERY_FAILURE);
    if (Number.isFinite(timeMs)) this.observe(Metric.RECOVERY_TIME, timeMs);
  }

  /** The connection success rate `[0,1]` from the accumulated counters. */
  connectionSuccessRate() {
    const s = this._val(Metric.CONNECTION_SUCCESS);
    const f = this._val(Metric.CONNECTION_FAILURE);
    return s + f === 0 ? 1 : s / (s + f);
  }

  /** The recovery success rate `[0,1]`. */
  recoverySuccessRate() {
    const s = this._val(Metric.RECOVERY_SUCCESS);
    const f = this._val(Metric.RECOVERY_FAILURE);
    return s + f === 0 ? 1 : s / (s + f);
  }

  // === export ==============================================================

  snapshot() {
    const counters = {};
    const gauges = {};
    for (const [k, v] of this._scalars) (v.type === MetricType.COUNTER ? counters : gauges)[k] = v.value;
    const histograms = {};
    for (const [k, h] of this._histograms) {
      histograms[k] = { count: h.count, sum: Number(h.sum.toFixed(3)), avg: h.count ? Number((h.sum / h.count).toFixed(3)) : 0, min: h.count ? Number(h.min.toFixed(3)) : 0, max: h.count ? Number(h.max.toFixed(3)) : 0 };
    }
    return { counters, gauges, histograms };
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
        /* an exporter failure must never break the connectivity path */
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

/**
 * @module networking-hardening/observability
 *
 * **Production metrics registry** for the networking control plane. A dependency-free, in-process
 * registry of counters, gauges, and histograms, with a `snapshot()`, a Prometheus text-exposition
 * renderer, and an OpenTelemetry export hook. Wire it into any Layer-6 subsystem's event bus to
 * record discovery latency + success rate, presence update rate, heartbeat failures, negotiation
 * latency, connection-plan generation, endpoint-selection latency, cache hit ratio, repository
 * latency, and concurrent discoveries.
 *
 * @security Metrics are numeric aggregates + low-cardinality label sets — NEVER key material or
 * per-request ids as labels.
 *
 * @example
 * ```js
 * const metrics = new NetworkingMetrics();
 * const stop = metrics.startTimer(Metric.DISCOVERY_LATENCY);
 * // ... run discovery ...
 * stop();                                     // observes elapsed ms
 * metrics.recordDiscovery(true);              // success
 * console.log(metrics.prometheus());          // Prometheus exposition format
 * ```
 */

import { MetricType, Metric } from "../types/types.js";

/** Default histogram buckets (ms) for latency metrics. */
const DEFAULT_BUCKETS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];

export class NetworkingMetrics {
  /** @param {{ clock?: () => number, buckets?: number[] }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this._buckets = options.buckets ?? DEFAULT_BUCKETS;
    /** @type {Map<string, { type: string, value: number }>} */
    this._scalars = new Map();
    /** @type {Map<string, { count: number, sum: number, min: number, max: number, buckets: Map<number, number> }>} */
    this._histograms = new Map();
    this._exporters = [];
  }

  /** Increment a counter by `n` (default 1). @returns {number} new value */
  increment(name, n = 1, labels) {
    const k = this._key(name, labels);
    const cur = this._scalars.get(k) ?? { type: MetricType.COUNTER, value: 0 };
    cur.value += n;
    this._scalars.set(k, cur);
    return cur.value;
  }

  /** Set a gauge to `value`. */
  gauge(name, value, labels) {
    this._scalars.set(this._key(name, labels), { type: MetricType.GAUGE, value });
    return value;
  }

  /** Observe a value into a histogram (e.g. a latency in ms). */
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

  // === networking-specific convenience recorders ===========================

  /** Record a discovery outcome (updates total + success/failure). */
  recordDiscovery(success) {
    this.increment(Metric.DISCOVERY_TOTAL);
    this.increment(success ? Metric.DISCOVERY_SUCCESS : Metric.DISCOVERY_FAILURE);
    return this.discoverySuccessRate();
  }

  /** Record a cache probe (hit/miss) + refresh the hit-ratio gauge. */
  recordCache(hit) {
    this.increment(hit ? Metric.CACHE_HIT : Metric.CACHE_MISS);
    const hits = this._scalarValue(Metric.CACHE_HIT);
    const misses = this._scalarValue(Metric.CACHE_MISS);
    const ratio = hits + misses === 0 ? 0 : hits / (hits + misses);
    this.gauge(Metric.CACHE_HIT_RATIO, Number(ratio.toFixed(4)));
    return ratio;
  }

  /** The discovery success rate `[0,1]` from the accumulated counters. */
  discoverySuccessRate() {
    const s = this._scalarValue(Metric.DISCOVERY_SUCCESS);
    const f = this._scalarValue(Metric.DISCOVERY_FAILURE);
    return s + f === 0 ? 1 : s / (s + f);
  }

  // === export ==============================================================

  /** A structured snapshot of all metrics. */
  snapshot() {
    const counters = {};
    const gauges = {};
    for (const [k, v] of this._scalars) (v.type === MetricType.COUNTER ? counters : gauges)[k] = v.value;
    const histograms = {};
    for (const [k, h] of this._histograms) {
      histograms[k] = {
        count: h.count,
        sum: Number(h.sum.toFixed(3)),
        avg: h.count ? Number((h.sum / h.count).toFixed(3)) : 0,
        min: h.count ? Number(h.min.toFixed(3)) : 0,
        max: h.count ? Number(h.max.toFixed(3)) : 0,
      };
    }
    return { counters, gauges, histograms };
  }

  /** Render the registry in Prometheus text-exposition format. */
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

  /**
   * Register an OpenTelemetry-style exporter `fn(snapshot)`. Call {@link exportMetrics} to flush.
   * This is the future OTel/Prometheus integration hook — Sprint 6 provides the seam, not a vendor
   * SDK. @returns {() => void} unregister
   */
  registerExporter(fn) {
    this._exporters.push(fn);
    return () => {
      this._exporters = this._exporters.filter((e) => e !== fn);
    };
  }

  /** Flush the current snapshot to all registered exporters (exporter failures are swallowed). */
  exportMetrics() {
    const snap = this.snapshot();
    for (const fn of this._exporters) {
      try {
        fn(snap);
      } catch {
        /* an exporter failure must never break the networking path */
      }
    }
    return snap;
  }

  /** Reset all metrics (e.g. between test cases). */
  reset() {
    this._scalars.clear();
    this._histograms.clear();
  }

  /** @private */
  _scalarValue(name, labels) {
    return this._scalars.get(this._key(name, labels))?.value ?? 0;
  }

  /** @private */
  _key(name, labels) {
    if (!labels || Object.keys(labels).length === 0) return name;
    const l = Object.keys(labels).sort().map((key) => `${key}="${String(labels[key])}"`).join(",");
    return `${name}{${l}}`;
  }

  /** @private */
  _parse(k) {
    const i = k.indexOf("{");
    return i === -1 ? { name: k, labels: "" } : { name: k.slice(0, i), labels: k.slice(i) };
  }

  /** @private Insert an `le` label into an existing label set (or create one). */
  _withLe(labels, le) {
    if (!labels) return `{le="${le}"}`;
    return `${labels.slice(0, -1)},le="${le}"}`;
  }
}

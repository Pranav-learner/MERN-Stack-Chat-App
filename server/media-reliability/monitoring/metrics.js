/**
 * @module media-reliability/monitoring/metrics
 *
 * **Production metrics registry** for the Secure Media Platform. A dependency-free, in-process registry
 * of counters, gauges, and histograms, with `snapshot()`, a Prometheus text-exposition renderer, and an
 * OpenTelemetry export hook. Wire it into the reliability manager to record upload/download/streaming
 * throughput, upload/download success rate, average upload/download time, recovery success rate, cache
 * hit rate, synchronization latency, bytes transferred, storage errors, pending chunks, concurrent
 * operations, and health score.
 *
 * @security Metrics are numeric aggregates + low-cardinality labels — NEVER content, per-media ids as
 * labels, or key material.
 */

import { MetricType, Metric } from "../types/types.js";

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000];

export class MediaMetrics {
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

  // === media-specific recorders ============================================

  /** Record a completed/failed media operation (generic total + success/failure). */
  recordOperation(success) {
    this.increment(Metric.OPERATION_TOTAL);
    this.increment(success ? Metric.OPERATION_SUCCESS : Metric.OPERATION_FAILURE);
    return this.operationSuccessRate();
  }

  /** Record an upload outcome (total/success/failure) + time + throughput. */
  recordUpload(success, timeMs, bytes) {
    this.increment(Metric.UPLOAD_TOTAL);
    this.increment(success ? Metric.UPLOAD_SUCCESS : Metric.UPLOAD_FAILURE);
    if (Number.isFinite(timeMs)) this.observe(Metric.UPLOAD_TIME, timeMs);
    if (Number.isFinite(bytes)) this.increment(Metric.BYTES_TRANSFERRED, bytes);
    if (Number.isFinite(bytes) && Number.isFinite(timeMs) && timeMs > 0) this.observe(Metric.UPLOAD_THROUGHPUT, Math.round((bytes / timeMs) * 1000));
  }

  /** Record a download outcome + time + throughput. */
  recordDownload(success, timeMs, bytes) {
    this.increment(Metric.DOWNLOAD_TOTAL);
    this.increment(success ? Metric.DOWNLOAD_SUCCESS : Metric.DOWNLOAD_FAILURE);
    if (Number.isFinite(timeMs)) this.observe(Metric.DOWNLOAD_TIME, timeMs);
    if (Number.isFinite(bytes)) this.increment(Metric.BYTES_TRANSFERRED, bytes);
    if (Number.isFinite(bytes) && Number.isFinite(timeMs) && timeMs > 0) this.observe(Metric.DOWNLOAD_THROUGHPUT, Math.round((bytes / timeMs) * 1000));
  }

  /** Record a streaming session outcome + throughput. */
  recordStreaming(timeMs, bytes) {
    this.increment(Metric.STREAMING_TOTAL);
    if (Number.isFinite(bytes) && Number.isFinite(timeMs) && timeMs > 0) this.observe(Metric.STREAMING_THROUGHPUT, Math.round((bytes / timeMs) * 1000));
  }

  recordSyncLatency(latencyMs) {
    if (Number.isFinite(latencyMs)) this.observe(Metric.SYNC_LATENCY, latencyMs);
  }
  recordStorageError() {
    this.increment(Metric.STORAGE_ERRORS);
  }
  recordCache(hit) {
    this.increment(hit ? Metric.CACHE_HIT : Metric.CACHE_MISS);
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

  /** Record per-operation gauges (pending chunks). */
  recordProgress({ pendingChunks } = {}) {
    if (Number.isFinite(pendingChunks)) this.gauge(Metric.PENDING_CHUNKS, pendingChunks);
  }

  operationSuccessRate() {
    return rate(this._val(Metric.OPERATION_SUCCESS), this._val(Metric.OPERATION_FAILURE));
  }
  uploadSuccessRate() {
    return rate(this._val(Metric.UPLOAD_SUCCESS), this._val(Metric.UPLOAD_FAILURE));
  }
  downloadSuccessRate() {
    return rate(this._val(Metric.DOWNLOAD_SUCCESS), this._val(Metric.DOWNLOAD_FAILURE));
  }
  recoverySuccessRate() {
    return rate(this._val(Metric.RECOVERY_SUCCESS), this._val(Metric.RECOVERY_FAILURE));
  }
  cacheHitRate() {
    const h = this._val(Metric.CACHE_HIT);
    const m = this._val(Metric.CACHE_MISS);
    return h + m === 0 ? 0 : round(h / (h + m));
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
    return { counters, gauges, histograms, operationSuccessRate: this.operationSuccessRate(), uploadSuccessRate: this.uploadSuccessRate(), downloadSuccessRate: this.downloadSuccessRate(), recoverySuccessRate: this.recoverySuccessRate(), cacheHitRate: this.cacheHitRate() };
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
        /* an exporter failure must never break the media path */
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

function rate(s, f) {
  return s + f === 0 ? 1 : round(s / (s + f));
}
function round(n) {
  return Number(n.toFixed(4));
}

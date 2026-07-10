/**
 * @module shs/hardening/observability/metrics
 *
 * A tiny, dependency-free metrics collector for the Secure Handshake System:
 * **counters** (monotonic), **gauges** (point-in-time), and **histograms** (latency /
 * size distributions with p50/p95/p99). It is in-process and export-agnostic —
 * {@link MetricsCollector#snapshot} yields a plain object a future exporter (Prometheus,
 * OpenTelemetry, …) can format.
 *
 * @security Metrics are aggregate counts/latencies only — no identifiers, keys, or
 * payloads.
 */

/** Well-known metric names (stable strings for dashboards). */
export const Metric = Object.freeze({
  HANDSHAKES_STARTED: "handshakes.started",
  HANDSHAKES_COMPLETED: "handshakes.completed",
  HANDSHAKES_FAILED: "handshakes.failed",
  HANDSHAKES_ACTIVE: "handshakes.active",
  KEY_AGREEMENTS_COMPLETED: "key_agreements.completed",
  KEY_AGREEMENTS_FAILED: "key_agreements.failed",
  SESSIONS_CREATED: "sessions.created",
  SESSIONS_ACTIVE: "sessions.active",
  SESSIONS_EXPIRED: "sessions.expired",
  RETRIES: "handshakes.retries",
  REPLAYS_DETECTED: "hardening.replays_detected",
  DOWNGRADES_BLOCKED: "hardening.downgrades_blocked",
  INTEGRITY_VIOLATIONS: "hardening.integrity_violations",
  RECOVERIES: "hardening.recoveries",
  HANDSHAKE_LATENCY_MS: "handshakes.latency_ms",
  SESSION_CREATE_MS: "sessions.create_ms",
  VALIDATION_MS: "validation.ms",
});

/** A fixed-capacity reservoir with summary statistics. */
class Histogram {
  constructor(cap = 1024) {
    this._cap = cap;
    this._values = [];
    this._count = 0;
    this._sum = 0;
  }
  observe(v) {
    this._count++;
    this._sum += v;
    if (this._values.length < this._cap) this._values.push(v);
    else this._values[this._count % this._cap] = v; // ring overwrite
  }
  summary() {
    if (this._count === 0) return { count: 0, sum: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    const sorted = [...this._values].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return {
      count: this._count,
      sum: this._sum,
      mean: this._sum / this._count,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: q(50),
      p95: q(95),
      p99: q(99),
    };
  }
}

/** In-process metrics registry. */
export class MetricsCollector {
  constructor() {
    this._counters = new Map();
    this._gauges = new Map();
    this._histograms = new Map();
  }

  /** Increment a counter by `n` (default 1). */
  increment(name, n = 1) {
    this._counters.set(name, (this._counters.get(name) ?? 0) + n);
  }

  /** Set a gauge to a value. */
  gauge(name, value) {
    this._gauges.set(name, value);
  }

  /** Record a value into a histogram (e.g. a latency). */
  observe(name, value) {
    let h = this._histograms.get(name);
    if (!h) this._histograms.set(name, (h = new Histogram()));
    h.observe(value);
  }

  /**
   * Time an async function, recording its duration into a histogram.
   * @template T @param {string} name @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  async time(name, fn, clock = () => Date.now()) {
    const start = clock();
    try {
      return await fn();
    } finally {
      this.observe(name, clock() - start);
    }
  }

  /** A single counter value. */
  counter(name) {
    return this._counters.get(name) ?? 0;
  }

  /** A plain, serializable snapshot of all metrics. */
  snapshot() {
    const histograms = {};
    for (const [name, h] of this._histograms) histograms[name] = h.summary();
    return {
      counters: Object.fromEntries(this._counters),
      gauges: Object.fromEntries(this._gauges),
      histograms,
    };
  }

  /** Reset all metrics (e.g. between test cases). */
  reset() {
    this._counters.clear();
    this._gauges.clear();
    this._histograms.clear();
  }
}

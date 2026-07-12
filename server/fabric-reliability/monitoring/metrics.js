/**
 * @module fabric-reliability/monitoring/metrics
 *
 * **Fabric production metrics** (STEP 6) — the observability core. It records counters, gauges, and
 * latency histograms for every reliability-relevant signal the sprint enumerates (communication
 * throughput, decision / routing / scheduler latency, policy-evaluation time, execution + recovery success
 * rate, subsystem availability, queue depth, QoS distribution, circuit state) and exposes them three ways:
 * a structured JSON snapshot, a **Prometheus** text exposition, and an **OpenTelemetry**-shaped metric
 * list — the future-facing hooks the spec calls for. It also provides a structured-logging + tracing
 * facade so orchestration decisions emit machine-parseable records.
 *
 * @performance O(1) record; snapshots are O(metrics). No timers, no I/O (an injected logger sink handles
 * emission).
 * @security Records numbers + label ids + classifications only. No content.
 */

import { MetricName } from "../types/types.js";

export class FabricMetrics {
  /** @param {object} [opts] `{ clock, logger }` (logger: (record) => void — default no-op) */
  constructor(opts = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.logger = opts.logger ?? (() => {});
    this._counters = new Map();
    this._gauges = new Map();
    this._histograms = new Map();
    this._rates = new Map(); // name → { ok, total }
  }

  // === primitives ===========================================================

  incr(name, by = 1, labels = null) {
    const key = keyOf(name, labels);
    this._counters.set(key, (this._counters.get(key) ?? 0) + by);
  }

  setGauge(name, value, labels = null) {
    this._gauges.set(keyOf(name, labels), value);
  }

  observe(name, value, labels = null) {
    const key = keyOf(name, labels);
    let h = this._histograms.get(key);
    if (!h) this._histograms.set(key, (h = { count: 0, sum: 0, min: Infinity, max: -Infinity }));
    h.count++;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
  }

  /** Track a success/total rate (for success-rate gauges). */
  rate(name, ok) {
    let r = this._rates.get(name);
    if (!r) this._rates.set(name, (r = { ok: 0, total: 0 }));
    r.total++;
    if (ok) r.ok++;
    this.setGauge(name, r.total > 0 ? r.ok / r.total : 1);
  }

  // === domain recorders =====================================================

  /** Record a completed operation: throughput + per-kind latency + execution success rate. */
  recordOperation(kind, { ok, latencyMs, failureClass } = {}) {
    this.incr(MetricName.COMMUNICATION_THROUGHPUT, 1, { kind });
    if (typeof latencyMs === "number") this.observe(MetricName.OPERATION_LATENCY, latencyMs, { kind });
    this.rate(MetricName.EXECUTION_SUCCESS_RATE, !!ok);
    if (!ok && failureClass) this.incr("fabric_operation_failures_total", 1, { kind, class: failureClass });
  }

  recordDecisionLatency(ms) {
    this.observe(MetricName.DECISION_LATENCY, ms);
  }
  recordRoutingLatency(ms) {
    this.observe(MetricName.ROUTING_LATENCY, ms);
  }
  recordSchedulerLatency(ms) {
    this.observe(MetricName.SCHEDULER_LATENCY, ms);
  }
  recordPolicyEval(ms) {
    this.observe(MetricName.POLICY_EVAL_TIME, ms);
  }
  recordRecovery(ok) {
    this.rate(MetricName.RECOVERY_SUCCESS_RATE, !!ok);
  }
  recordQoS(qosClass) {
    this.incr(MetricName.QOS_DISTRIBUTION, 1, { class: qosClass });
  }
  setQueueDepth(depth, lane = "total") {
    this.setGauge(MetricName.QUEUE_DEPTH, depth, { lane });
  }
  setSubsystemAvailability(kind, available) {
    this.setGauge(MetricName.SUBSYSTEM_AVAILABILITY, available ? 1 : 0, { subsystem: kind });
  }
  setCircuitState(name, stateOrdinal) {
    this.setGauge(MetricName.CIRCUIT_STATE, stateOrdinal, { circuit: name });
  }

  // === structured logging + tracing =========================================

  /** Emit a structured log record via the injected sink. */
  log(level, event, fields = {}) {
    const record = { level, event, at: new Date(this.clock()).toISOString(), ...fields };
    try {
      this.logger(record);
    } catch {
      /* never let logging break the caller */
    }
    return record;
  }

  // === export ===============================================================

  /** A structured JSON snapshot of every metric. */
  snapshot() {
    const histograms = {};
    for (const [k, h] of this._histograms) histograms[k] = { count: h.count, sum: round2(h.sum), avg: h.count ? round2(h.sum / h.count) : 0, min: h.min === Infinity ? 0 : round2(h.min), max: h.max === -Infinity ? 0 : round2(h.max) };
    return { counters: Object.fromEntries(this._counters), gauges: Object.fromEntries(this._gauges), histograms, at: new Date(this.clock()).toISOString() };
  }

  /** Prometheus text exposition (future Prometheus scrape hook). */
  prometheus() {
    const lines = [];
    for (const [key, val] of this._counters) lines.push(`${promName(key)} ${val}`);
    for (const [key, val] of this._gauges) lines.push(`${promName(key)} ${val}`);
    for (const [key, h] of this._histograms) {
      const base = promName(key);
      lines.push(`${base}_count ${h.count}`);
      lines.push(`${base}_sum ${round2(h.sum)}`);
    }
    return lines.join("\n") + "\n";
  }

  /** OpenTelemetry-shaped metric list (future OTel export hook). */
  otel() {
    const out = [];
    for (const [key, val] of this._counters) out.push({ name: nameOf(key), type: "counter", value: val, attributes: labelsOf(key) });
    for (const [key, val] of this._gauges) out.push({ name: nameOf(key), type: "gauge", value: val, attributes: labelsOf(key) });
    for (const [key, h] of this._histograms) out.push({ name: nameOf(key), type: "histogram", value: { count: h.count, sum: round2(h.sum) }, attributes: labelsOf(key) });
    return out;
  }
}

function keyOf(name, labels) {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .filter(([, v]) => v != null)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `${name}{${parts}}`;
}
function nameOf(key) {
  const i = key.indexOf("{");
  return i < 0 ? key : key.slice(0, i);
}
function labelsOf(key) {
  const m = key.match(/\{(.+)\}$/);
  if (!m) return {};
  return Object.fromEntries(m[1].split(",").map((p) => p.split("=")));
}
function promName(key) {
  const i = key.indexOf("{");
  if (i < 0) return key;
  const name = key.slice(0, i);
  const labels = key
    .slice(i + 1, -1)
    .split(",")
    .map((p) => {
      const [k, v] = p.split("=");
      return `${k}="${v}"`;
    })
    .join(",");
  return `${name}{${labels}}`;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

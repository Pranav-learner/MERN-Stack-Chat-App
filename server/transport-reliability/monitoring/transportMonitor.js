/**
 * @module transport-reliability/monitoring/monitor
 *
 * **Production monitor + alerting.** Subscribes to the reliability event bus (and, optionally, the
 * Transport-Engine event bus), maintains rolling per-window counters, and raises typed alerts when a
 * signal crosses its threshold — transfer-failure spikes, repeated recovery failures, unhealthy
 * transfers, stall timeouts, retry/backpressure/migration storms. Alerts are persisted via an injected
 * sink + surfaced through the API.
 *
 * @security Alerts carry ids + counts + reasons ONLY — never payload bytes or keys.
 */

import { AlertType, AlertSeverity, ReliabilityEventType, DEFAULT_MONITOR_WINDOW_MS, DEFAULT_ALERT_THRESHOLDS, Metric } from "../types/types.js";

export class TransportMonitor {
  /** @param {{ events?: object, metrics?: object, sink?: object, thresholds?: object, windowMs?: number, clock?: () => number }} [deps] */
  constructor(deps = {}) {
    this.metrics = deps.metrics ?? null;
    this.sink = deps.sink ?? null; // { record(alert) }
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(deps.thresholds ?? {}) };
    this.windowMs = deps.windowMs ?? DEFAULT_MONITOR_WINDOW_MS;
    this.clock = deps.clock ?? (() => Date.now());
    /** @type {Map<string, number[]>} signal -> timestamps in the current window */
    this._events = new Map();
    /** @type {object[]} recent alerts (in-memory ring) */
    this._alerts = [];
    this._maxAlerts = deps.maxAlerts ?? 500;
    this._unsub = [];
    if (deps.events) this.subscribe(deps.events);
  }

  /** Subscribe to a reliability event bus. @returns {() => void} */
  subscribe(bus) {
    const off = bus.on("*", (e) => this._onEvent(e));
    this._unsub.push(off);
    return off;
  }

  /** Record + evaluate a signal. @returns {object|null} an alert if one fired */
  track(signal, alertType, severity = AlertSeverity.WARNING, details = {}) {
    const now = this.clock();
    const arr = this._events.get(signal) ?? [];
    arr.push(now);
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
    this._events.set(signal, arr);
    const threshold = this.thresholds[alertType] ?? Infinity;
    if (arr.length >= threshold) return this._raise(alertType, severity, { count: arr.length, windowMs: this.windowMs, ...details });
    return null;
  }

  /** Current rolling count for a signal. */
  count(signal) {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const arr = (this._events.get(signal) ?? []).filter((t) => t >= cutoff);
    this._events.set(signal, arr);
    return arr.length;
  }

  /** Recent alerts (newest first). */
  recentAlerts(limit = 50) {
    return this._alerts.slice(-limit).reverse();
  }

  /** @private map inbound events → signals + alerts. */
  _onEvent(event) {
    switch (event.type) {
      case ReliabilityEventType.TRANSFER_FAILED:
        this.track("transfer-failure", AlertType.TRANSFER_FAILURE_SPIKE, AlertSeverity.CRITICAL, { transferId: event.transferId });
        break;
      case ReliabilityEventType.RECOVERY_FAILED:
        this.track("recovery-failure", AlertType.REPEATED_RECOVERY_FAILURE, AlertSeverity.CRITICAL, { transferId: event.transferId });
        break;
      case ReliabilityEventType.TRANSFER_INTERRUPTED:
        this.track("stall", AlertType.STALL_TIMEOUT, AlertSeverity.WARNING, { transferId: event.transferId, trigger: event.trigger });
        break;
      case ReliabilityEventType.MIGRATION_STARTED:
        this.track("migration", AlertType.MIGRATION_STORM, AlertSeverity.WARNING, { transferId: event.transferId });
        break;
      case ReliabilityEventType.HEALTH_CHANGED:
        if (event.status === "unhealthy") this.track("unhealthy", AlertType.UNHEALTHY_TRANSFER, AlertSeverity.WARNING, { transferId: event.transferId });
        break;
      default:
        break;
    }
  }

  /** @private raise + persist an alert. */
  _raise(type, severity, details) {
    const alert = { type, severity, at: new Date(this.clock()).toISOString(), details };
    this._alerts.push(alert);
    if (this._alerts.length > this._maxAlerts) this._alerts.shift();
    this.metrics?.increment(Metric.ALERT_TOTAL, 1, { type });
    try {
      this.sink?.record?.(alert);
    } catch {
      /* alert persistence failure must never break the transport path */
    }
    return alert;
  }

  dispose() {
    for (const off of this._unsub) off();
    this._unsub = [];
  }
}

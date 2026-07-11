/**
 * @module synchronization-reliability/monitoring/monitor
 *
 * **Production monitor + alerting.** Subscribes to the reliability event bus, maintains rolling per-
 * window counters, and raises typed alerts when a signal crosses its threshold — sync-failure spikes,
 * repeated recovery failures, unhealthy replicas, stall timeouts, high conflict rate, high replica
 * drift, and retry storms. Alerts are persisted via an injected sink + surfaced through the API.
 *
 * @security Alerts carry ids + counts + reasons ONLY — never content or keys.
 */

import { AlertType, AlertSeverity, ReliabilityEventType, DEFAULT_MONITOR_WINDOW_MS, DEFAULT_ALERT_THRESHOLDS, Metric } from "../types/types.js";

export class SyncMonitor {
  /** @param {{ events?: object, metrics?: object, sink?: object, thresholds?: object, windowMs?: number, clock?: () => number, maxAlerts?: number }} [deps] */
  constructor(deps = {}) {
    this.metrics = deps.metrics ?? null;
    this.sink = deps.sink ?? null;
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(deps.thresholds ?? {}) };
    this.windowMs = deps.windowMs ?? DEFAULT_MONITOR_WINDOW_MS;
    this.clock = deps.clock ?? (() => Date.now());
    this._events = new Map();
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

  count(signal) {
    const cutoff = this.clock() - this.windowMs;
    const arr = (this._events.get(signal) ?? []).filter((t) => t >= cutoff);
    this._events.set(signal, arr);
    return arr.length;
  }

  recentAlerts(limit = 50) {
    return this._alerts.slice(-limit).reverse();
  }

  /** @private map inbound events → signals + alerts. */
  _onEvent(event) {
    switch (event.type) {
      case ReliabilityEventType.SYNC_FAILED:
        this.track("sync-failure", AlertType.SYNC_FAILURE_SPIKE, AlertSeverity.CRITICAL, { syncId: event.syncId });
        break;
      case ReliabilityEventType.RECOVERY_FAILED:
        this.track("recovery-failure", AlertType.REPEATED_RECOVERY_FAILURE, AlertSeverity.CRITICAL, { syncId: event.syncId });
        break;
      case ReliabilityEventType.SYNC_INTERRUPTED:
        this.track("stall", AlertType.STALL_TIMEOUT, AlertSeverity.WARNING, { syncId: event.syncId, trigger: event.trigger });
        break;
      case ReliabilityEventType.DRIFT_DETECTED:
        this.track("drift", AlertType.HIGH_REPLICA_DRIFT, AlertSeverity.WARNING, { syncId: event.syncId, drift: event.drift });
        break;
      case ReliabilityEventType.HEALTH_CHANGED:
        if (event.status === "unhealthy") this.track("unhealthy", AlertType.UNHEALTHY_REPLICA, AlertSeverity.WARNING, { syncId: event.syncId });
        if (event.conflictRate != null && event.conflictRate >= 0.5) this.track("conflict-rate", AlertType.HIGH_CONFLICT_RATE, AlertSeverity.WARNING, { syncId: event.syncId, conflictRate: event.conflictRate });
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
      /* alert persistence failure must never break the sync path */
    }
    return alert;
  }

  dispose() {
    for (const off of this._unsub) off();
    this._unsub = [];
  }
}

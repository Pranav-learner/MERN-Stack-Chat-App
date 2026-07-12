/**
 * @module media-reliability/monitoring/monitor
 *
 * **Production monitor + alerting.** Subscribes to the reliability event bus, maintains rolling per-
 * window counters, and raises typed alerts when a signal crosses its threshold — operation-failure
 * spikes, repeated recovery failures, unhealthy media, stall timeouts, high transfer failure, storage-
 * failure spikes, large backlogs, and retry storms. Alerts are persisted via an injected sink + surfaced
 * through the API.
 *
 * @security Alerts carry ids + counts + reasons ONLY — never content or keys.
 */

import { AlertType, AlertSeverity, ReliabilityEventType, DEFAULT_MONITOR_WINDOW_MS, DEFAULT_ALERT_THRESHOLDS, Metric } from "../types/types.js";

export class MediaMonitor {
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
      case ReliabilityEventType.OPERATION_FAILED:
        this.track("operation-failure", AlertType.OPERATION_FAILURE_SPIKE, AlertSeverity.CRITICAL, { operationId: event.operationId, mediaId: event.mediaId });
        break;
      case ReliabilityEventType.RECOVERY_FAILED:
        this.track("recovery-failure", AlertType.REPEATED_RECOVERY_FAILURE, AlertSeverity.CRITICAL, { operationId: event.operationId });
        break;
      case ReliabilityEventType.OPERATION_INTERRUPTED:
        this.track("stall", AlertType.STALL_TIMEOUT, AlertSeverity.WARNING, { operationId: event.operationId, trigger: event.trigger });
        if (event.trigger === "storage-failure") this.track("storage-failure", AlertType.STORAGE_FAILURE_SPIKE, AlertSeverity.CRITICAL, { operationId: event.operationId });
        break;
      case ReliabilityEventType.BACKLOG_DETECTED:
        this.track("backlog", AlertType.LARGE_BACKLOG, AlertSeverity.WARNING, { operationId: event.operationId, backlog: event.backlog });
        break;
      case ReliabilityEventType.HEALTH_CHANGED:
        if (event.status === "unhealthy") this.track("unhealthy", AlertType.UNHEALTHY_MEDIA, AlertSeverity.WARNING, { operationId: event.operationId, mediaId: event.mediaId });
        if (event.failureRate != null && event.failureRate >= 0.5) this.track("transfer-failure", AlertType.HIGH_TRANSFER_FAILURE, AlertSeverity.WARNING, { operationId: event.operationId, failureRate: event.failureRate });
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
      /* alert persistence failure must never break the media path */
    }
    return alert;
  }

  dispose() {
    for (const off of this._unsub) off();
    this._unsub = [];
  }
}

/**
 * @module crypto-hardening/monitoring
 *
 * **Internal security monitoring.** Consumes security-relevant signals — replay detections,
 * repeated validation failures, generation-rollback attempts, repeated handshake failures,
 * key-lifecycle anomalies, repository inconsistencies, metadata corruption — accumulates them
 * over a sliding time window, and raises **alerts** when a threshold is crossed. Alerts are
 * emitted on the hardening event bus, recorded, and counted as metrics.
 *
 * @security The monitor sees METADATA only. Alerts carry ids/generations/reasons — never key
 * material. Monitoring is best-effort and must never block or break the crypto path.
 *
 * @example
 * ```js
 * const monitor = new SecurityMonitor({ events, metrics });
 * monitor.subscribe(replayGuard.events); // auto-feed from replay events
 * monitor.onValidationFailure({ sessionId, layer: "transport" });
 * monitor.report(); // { alerts: [...], counts: {...} }
 * ```
 */

import crypto from "node:crypto";
import {
  AlertType,
  AlertSeverity,
  HardeningEventType,
  DEFAULT_MONITOR_WINDOW_MS,
  DEFAULT_REPLAY_ALERT_THRESHOLD,
  DEFAULT_VALIDATION_FAILURE_THRESHOLD,
} from "../types/types.js";
import { HardeningEventBus } from "../events/events.js";

export class SecurityMonitor {
  /**
   * @param {object} [deps]
   * @param {HardeningEventBus} [deps.events] @param {import("../observability/metrics.js").MetricsRegistry} [deps.metrics]
   * @param {() => number} [deps.clock] @param {number} [deps.windowMs]
   * @param {Record<string, number>} [deps.thresholds] per-{@link AlertType} thresholds
   * @param {number} [deps.maxAlerts] recent-alert ring size
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.metrics = deps.metrics ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.windowMs = deps.windowMs ?? DEFAULT_MONITOR_WINDOW_MS;
    this.thresholds = {
      [AlertType.SUSPICIOUS_REPLAY]: DEFAULT_REPLAY_ALERT_THRESHOLD,
      [AlertType.REPEATED_VALIDATION_FAILURE]: DEFAULT_VALIDATION_FAILURE_THRESHOLD,
      [AlertType.GENERATION_ROLLBACK_ATTEMPT]: 3,
      [AlertType.REPEATED_HANDSHAKE_FAILURE]: 5,
      [AlertType.KEY_LIFECYCLE_ANOMALY]: 1,
      [AlertType.REPOSITORY_INCONSISTENCY]: 1,
      [AlertType.METADATA_CORRUPTION]: 1,
      ...(deps.thresholds ?? {}),
    };
    this._maxAlerts = deps.maxAlerts ?? 500;
    /** @type {Map<string, number[]>} windowed event timestamps per (type|key) */
    this._windows = new Map();
    /** @type {import("../types/types.js").SecurityAlert[]} */
    this._alerts = [];
  }

  // === signal feeders ======================================================

  /** A replay was detected. */
  onReplayDetected(ctx = {}) {
    return this._signal(AlertType.SUSPICIOUS_REPLAY, ctx.sessionId, AlertSeverity.WARNING, "Suspicious replay activity", ctx);
  }

  /** A validation failure occurred (transport / session / metadata). */
  onValidationFailure(ctx = {}) {
    return this._signal(AlertType.REPEATED_VALIDATION_FAILURE, ctx.sessionId, AlertSeverity.WARNING, "Repeated validation failures", ctx);
  }

  /** A generation rollback was attempted. */
  onRollbackAttempt(ctx = {}) {
    return this._signal(AlertType.GENERATION_ROLLBACK_ATTEMPT, ctx.sessionId, AlertSeverity.CRITICAL, "Generation rollback attempt", ctx);
  }

  /** A handshake failed. */
  onHandshakeFailure(ctx = {}) {
    return this._signal(AlertType.REPEATED_HANDSHAKE_FAILURE, ctx.sessionId, AlertSeverity.WARNING, "Repeated handshake failures", ctx);
  }

  /** A key-lifecycle anomaly was found (verifier). */
  onLifecycleAnomaly(ctx = {}) {
    return this._signal(AlertType.KEY_LIFECYCLE_ANOMALY, ctx.sessionId, AlertSeverity.CRITICAL, "Key lifecycle anomaly", ctx);
  }

  /** A repository inconsistency was found. */
  onRepositoryInconsistency(ctx = {}) {
    return this._signal(AlertType.REPOSITORY_INCONSISTENCY, ctx.sessionId, AlertSeverity.CRITICAL, "Repository inconsistency", ctx);
  }

  /** Metadata corruption was detected. */
  onMetadataCorruption(ctx = {}) {
    return this._signal(AlertType.METADATA_CORRUPTION, ctx.sessionId, AlertSeverity.CRITICAL, "Metadata corruption", ctx);
  }

  // === wiring ==============================================================

  /**
   * Auto-subscribe to a hardening event bus so replay events feed the monitor.
   * @param {HardeningEventBus} bus @returns {() => void} unsubscribe
   */
  subscribe(bus) {
    const offs = [
      bus.on(HardeningEventType.REPLAY_DETECTED, (e) => this.onReplayDetected({ sessionId: e.sessionId, reason: e.reason })),
      bus.on(HardeningEventType.LIFECYCLE_VIOLATION, (e) => this.onLifecycleAnomaly({ sessionId: e.sessionId, reason: e.reason })),
    ];
    return () => offs.forEach((off) => off());
  }

  // === reporting ===========================================================

  /** Recent alerts (newest last). */
  get alerts() {
    return this._alerts.map((a) => ({ ...a }));
  }

  /** A report of current windowed counts + recent alerts. */
  report() {
    const now = this.clock();
    const counts = {};
    for (const [k, times] of this._windows) {
      const live = times.filter((t) => now - t < this.windowMs).length;
      if (live > 0) counts[k] = live;
    }
    return { counts, alerts: this.alerts, activeAlerts: this._alerts.filter((a) => now - new Date(a.at).getTime() < this.windowMs).length };
  }

  // === internals ==========================================================

  /** @private Record a signal; raise an alert if the threshold is crossed within the window. */
  _signal(type, sessionId, severity, message, ctx) {
    const key = `${type}|${sessionId ?? "*"}`;
    const now = this.clock();
    const times = (this._windows.get(key) ?? []).filter((t) => now - t < this.windowMs);
    times.push(now);
    this._windows.set(key, times);
    this.metrics?.increment("security_signals_total", 1, { type });

    const threshold = this.thresholds[type] ?? 1;
    if (times.length >= threshold) {
      this._windows.set(key, []); // reset so we alert once per window (cooldown)
      return this._raiseAlert(type, severity, message, { sessionId, count: times.length, ...stripSecrets(ctx) });
    }
    return null;
  }

  /** @private Raise + record an alert. */
  _raiseAlert(type, severity, message, details) {
    const alert = {
      alertId: crypto.randomUUID(),
      type,
      severity,
      sessionId: details?.sessionId,
      message,
      details: stripSecrets(details),
      at: new Date(this.clock()).toISOString(),
    };
    this._alerts.push(alert);
    if (this._alerts.length > this._maxAlerts) this._alerts = this._alerts.slice(this._alerts.length - this._maxAlerts);
    this.metrics?.increment("security_alerts_total", 1, { type, severity });
    // NOTE: do not name a payload field `type` — the event bus builds `{ type, at, ...payload }`,
    // so a payload `type` would clobber the event's channel type. Use `alertType` instead.
    this.events.emit(HardeningEventType.ALERT_RAISED, { alertId: alert.alertId, alertType: type, severity, sessionId: alert.sessionId, reason: message });
    return alert;
  }
}

/** Defensive: never let key-like fields into an alert. */
function stripSecrets(ctx) {
  if (!ctx || typeof ctx !== "object") return ctx;
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (/key|secret|bytes/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

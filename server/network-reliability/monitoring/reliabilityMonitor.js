/**
 * @module network-reliability/monitoring
 *
 * **Reliability monitoring + alerting.** Consumes connectivity signals — connection failures,
 * repeated recovery failures, unhealthy connections, heartbeat timeouts, relay overuse, NAT-rebind
 * / reconnect storms — accumulates them over a sliding window, and raises ALERTS when a threshold is
 * crossed. Alerts emit on the reliability bus, persist to a sink, and count as metrics.
 *
 * @security The monitor sees METADATA only. Alerts carry ids/counts/reasons — never key material.
 * Monitoring is best-effort and never blocks/breaks the connectivity path.
 */

import crypto from "node:crypto";
import {
  AlertType,
  AlertSeverity,
  HealthStatus,
  ReliabilityEventType,
  Metric,
  DEFAULT_MONITOR_WINDOW_MS,
  DEFAULT_ALERT_THRESHOLDS,
} from "../types/types.js";
import { ReliabilityEventBus } from "../events/events.js";

export class ReliabilityMonitor {
  /**
   * @param {object} [deps]
   * @param {ReliabilityEventBus} [deps.events] @param {import("../observability/metrics.js").ReliabilityMetrics} [deps.metrics]
   * @param {() => number} [deps.clock] @param {number} [deps.windowMs] @param {Record<string, number>} [deps.thresholds]
   * @param {object} [deps.sink] `{ record(alert) }` @param {() => string} [deps.idGenerator] @param {number} [deps.maxAlerts]
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new ReliabilityEventBus();
    this.metrics = deps.metrics ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.windowMs = deps.windowMs ?? DEFAULT_MONITOR_WINDOW_MS;
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(deps.thresholds ?? {}) };
    this.sink = deps.sink ?? null;
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this._maxAlerts = deps.maxAlerts ?? 500;
    this._windows = new Map();
    this._alerts = [];
  }

  onConnectionFailure(ctx = {}) {
    return this._signal(AlertType.CONNECTION_FAILURE_SPIKE, ctx.subject ?? "global", AlertSeverity.WARNING, "Elevated connection failures", ctx);
  }
  onRecoveryFailure(ctx = {}) {
    return this._signal(AlertType.REPEATED_RECOVERY_FAILURE, ctx.subject ?? ctx.connectionId, AlertSeverity.CRITICAL, "Repeated recovery failures", ctx);
  }
  onUnhealthyConnection(ctx = {}) {
    return this._signal(AlertType.UNHEALTHY_CONNECTION, ctx.subject ?? ctx.connectionId, AlertSeverity.WARNING, "Connection is unhealthy", ctx);
  }
  onHeartbeatTimeout(ctx = {}) {
    return this._signal(AlertType.HEARTBEAT_TIMEOUT, ctx.subject ?? ctx.connectionId, AlertSeverity.WARNING, "Heartbeat timeouts", ctx);
  }
  onRelayUse(ctx = {}) {
    return this._signal(AlertType.RELAY_OVERUSE, ctx.subject ?? "global", AlertSeverity.INFO, "High relay usage", ctx);
  }
  onNatRebind(ctx = {}) {
    return this._signal(AlertType.NAT_REBIND_STORM, ctx.subject ?? ctx.deviceId, AlertSeverity.WARNING, "NAT rebind storm", ctx);
  }
  onReconnect(ctx = {}) {
    return this._signal(AlertType.RECONNECT_STORM, ctx.subject ?? ctx.connectionId, AlertSeverity.WARNING, "Reconnect storm", ctx);
  }

  /** Auto-feed from a reliability event bus (recovery failures + unhealthy health changes). */
  subscribe(bus) {
    const offs = [];
    offs.push(bus.on(ReliabilityEventType.RECOVERY_FAILED, (e) => this.onRecoveryFailure({ connectionId: e?.connectionId })));
    offs.push(bus.on(ReliabilityEventType.HEARTBEAT_MISSED, (e) => this.onHeartbeatTimeout({ connectionId: e?.connectionId })));
    offs.push(bus.on(ReliabilityEventType.RELAY_FAILOVER, (e) => this.onRelayUse({ connectionId: e?.connectionId })));
    offs.push(bus.on(ReliabilityEventType.HEALTH_CHANGED, (e) => { if (e?.status === HealthStatus.UNHEALTHY) this.onUnhealthyConnection({ connectionId: e?.connectionId }); }));
    return () => offs.forEach((off) => off && off());
  }

  alerts(limit = 100) {
    return this._alerts.slice(-limit).reverse();
  }
  counts() {
    const now = this.clock();
    const out = {};
    for (const [key, times] of this._windows) {
      const type = key.split("|")[0];
      out[type] = (out[type] ?? 0) + times.filter((t) => now - t < this.windowMs).length;
    }
    return out;
  }
  health() {
    const now = this.clock();
    const recent = this._alerts.filter((a) => now - a.at < this.windowMs);
    if (recent.some((a) => a.severity === AlertSeverity.CRITICAL)) return HealthStatus.UNHEALTHY;
    if (recent.length > 0) return HealthStatus.DEGRADED;
    return HealthStatus.HEALTHY;
  }
  report() {
    return { health: this.health(), counts: this.counts(), alerts: this.alerts(50) };
  }

  /** @private */
  _signal(type, key, severity, message, ctx) {
    const now = this.clock();
    const wkey = `${type}|${key ?? "global"}`;
    const times = (this._windows.get(wkey) ?? []).filter((t) => now - t < this.windowMs);
    times.push(now);
    this._windows.set(wkey, times);
    if (times.length < (this.thresholds[type] ?? 1)) return null;

    const alert = { alertId: this.idGenerator(), alertType: type, severity, message, subject: key ?? null, count: times.length, at: now, details: sanitize(ctx) };
    this._alerts.push(alert);
    if (this._alerts.length > this._maxAlerts) this._alerts.splice(0, this._alerts.length - this._maxAlerts);
    this._windows.set(wkey, []);
    this.metrics?.increment(Metric.ALERT_TOTAL, 1, { type });
    this.events.emit(ReliabilityEventType.ALERT_RAISED, { alertType: type, severity, subject: key, count: alert.count, reason: message });
    if (this.sink?.record) {
      try {
        this.sink.record(alert);
      } catch {
        /* best-effort */
      }
    }
    return alert;
  }
}

function sanitize(ctx = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (["subject", "connectionId", "deviceId", "peerId", "trigger", "reason"].includes(k) && (typeof v === "string" || typeof v === "number")) out[k] = v;
  }
  return out;
}

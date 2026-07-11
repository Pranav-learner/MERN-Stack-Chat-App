/**
 * @module networking-hardening/monitoring
 *
 * **Networking monitoring + alerting.** Consumes health-relevant signals from the Layer-6 control
 * plane — discovery failures, repeated lookup failures, presence instability, capability mismatches,
 * repository failures, cache failures, abnormal endpoint churn, API failures — accumulates them over
 * a sliding window, and raises **alerts** when a threshold is crossed. Alerts are emitted on the
 * hardening event bus, recorded (optionally persisted), and counted as metrics.
 *
 * @security The monitor sees METADATA only. Alerts carry ids/counts/reasons — never key material.
 * Monitoring is best-effort and must never block or break the networking path.
 *
 * @example
 * ```js
 * const monitor = new NetworkMonitor({ events, metrics });
 * monitor.subscribe(discoveryEvents, { failEvent: "discovery.failed" }); // auto-feed
 * monitor.onDiscoveryFailure({ requester });
 * monitor.report(); // { alerts: [...], counts: {...}, health }
 * ```
 */

import crypto from "node:crypto";
import {
  AlertType,
  AlertSeverity,
  HealthStatus,
  HardeningEventType,
  Metric,
  DEFAULT_MONITOR_WINDOW_MS,
  DEFAULT_ALERT_THRESHOLDS,
} from "../types/types.js";
import { HardeningEventBus } from "../events/events.js";

export class NetworkMonitor {
  /**
   * @param {object} [deps]
   * @param {HardeningEventBus} [deps.events] @param {import("../observability/metrics.js").NetworkingMetrics} [deps.metrics]
   * @param {() => number} [deps.clock] @param {number} [deps.windowMs]
   * @param {Record<string, number>} [deps.thresholds] per-{@link AlertType} thresholds
   * @param {number} [deps.maxAlerts] recent-alert ring size @param {object} [deps.sink] `{ record(alert) }` optional persistence
   * @param {() => string} [deps.idGenerator]
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.metrics = deps.metrics ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.windowMs = deps.windowMs ?? DEFAULT_MONITOR_WINDOW_MS;
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(deps.thresholds ?? {}) };
    this.sink = deps.sink ?? null;
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this._maxAlerts = deps.maxAlerts ?? 500;
    /** @type {Map<string, number[]>} windowed timestamps per (type|key) */
    this._windows = new Map();
    /** @type {object[]} recent alerts */
    this._alerts = [];
  }

  // === signal feeders ======================================================

  /** A discovery run failed. */
  onDiscoveryFailure(ctx = {}) {
    return this._signal(AlertType.DISCOVERY_FAILURE_SPIKE, ctx.subject ?? "global", AlertSeverity.WARNING, "Elevated discovery failures", ctx);
  }

  /** A repeated lookup by the same requester/target keeps failing. */
  onRepeatedLookupFailure(ctx = {}) {
    return this._signal(AlertType.REPEATED_LOOKUP_FAILURE, ctx.subject ?? `${ctx.requester}:${ctx.targetUser}`, AlertSeverity.WARNING, "Repeated lookup failures", ctx);
  }

  /** A device flapped between reachable/unreachable (presence instability). */
  onPresenceInstability(ctx = {}) {
    return this._signal(AlertType.PRESENCE_INSTABILITY, ctx.subject ?? ctx.deviceId, AlertSeverity.WARNING, "Presence instability (flapping)", ctx);
  }

  /** A capability negotiation was incompatible. */
  onCapabilityMismatch(ctx = {}) {
    return this._signal(AlertType.CAPABILITY_MISMATCH_SPIKE, ctx.subject ?? "global", AlertSeverity.INFO, "Elevated capability mismatches", ctx);
  }

  /** A repository operation failed. */
  onRepositoryFailure(ctx = {}) {
    return this._signal(AlertType.REPOSITORY_FAILURE, ctx.subject ?? ctx.subsystem ?? "repository", AlertSeverity.CRITICAL, "Repository failures", ctx);
  }

  /** A cache operation failed / was found corrupt. */
  onCacheFailure(ctx = {}) {
    return this._signal(AlertType.CACHE_FAILURE, ctx.subject ?? ctx.subsystem ?? "cache", AlertSeverity.WARNING, "Cache failures", ctx);
  }

  /** A plan's endpoints churned abnormally fast (repeated failover/refresh). */
  onEndpointChurn(ctx = {}) {
    return this._signal(AlertType.ABNORMAL_ENDPOINT_CHURN, ctx.subject ?? ctx.planId, AlertSeverity.WARNING, "Abnormal endpoint churn", ctx);
  }

  /** An unexpected networking API error. */
  onApiFailure(ctx = {}) {
    return this._signal(AlertType.API_FAILURE_SPIKE, ctx.subject ?? ctx.route ?? "global", AlertSeverity.WARNING, "Elevated API failures", ctx);
  }

  /** A subject is being rate-limited repeatedly (possible abuse). */
  onRateLimitAbuse(ctx = {}) {
    return this._signal(AlertType.RATE_LIMIT_ABUSE, ctx.subject, AlertSeverity.WARNING, "Repeated rate-limit hits (possible abuse)", ctx);
  }

  /** A subject probed many distinct targets quickly (possible enumeration). */
  onEnumerationSuspected(ctx = {}) {
    return this._signal(AlertType.ENUMERATION_SUSPECTED, ctx.subject, AlertSeverity.WARNING, "Possible enumeration scan", ctx);
  }

  // === wiring ==============================================================

  /**
   * Auto-feed the monitor from a subsystem event bus. Provide the event names that map to signals.
   * @param {{ on: (type: string, handler: Function) => (() => void) }} bus
   * @param {{ failEvent?: string, onFail?: (e:object)=>void }} map
   * @returns {() => void} unsubscribe
   */
  subscribe(bus, map = {}) {
    const offs = [];
    if (map.failEvent) offs.push(bus.on(map.failEvent, (e) => (map.onFail ?? this.onDiscoveryFailure).call(this, { subject: e?.requester ?? e?.userId ?? "global", ...e })));
    offs.push(bus.on(HardeningEventType.CIRCUIT_OPENED, (e) => this.onRepositoryFailure({ subsystem: e?.subsystem })));
    offs.push(bus.on(HardeningEventType.RATE_LIMITED, (e) => this.onRateLimitAbuse({ subject: e?.subject })));
    return () => offs.forEach((off) => off && off());
  }

  // === reporting ===========================================================

  /** Recent alerts (newest first). @param {number} [limit] */
  alerts(limit = 100) {
    return this._alerts.slice(-limit).reverse();
  }

  /** Windowed signal counts per alert type (current window). */
  counts() {
    const now = this.clock();
    const out = {};
    for (const [key, times] of this._windows) {
      const type = key.split("|")[0];
      const live = times.filter((t) => now - t < this.windowMs).length;
      out[type] = (out[type] ?? 0) + live;
    }
    return out;
  }

  /** Overall health derived from recent CRITICAL/WARNING alert volume. */
  health() {
    const now = this.clock();
    const recent = this._alerts.filter((a) => now - a.at < this.windowMs);
    if (recent.some((a) => a.severity === AlertSeverity.CRITICAL)) return HealthStatus.UNHEALTHY;
    if (recent.length > 0) return HealthStatus.DEGRADED;
    return HealthStatus.HEALTHY;
  }

  /** A consolidated report (for the hardening API + health checks). */
  report() {
    return { health: this.health(), counts: this.counts(), alerts: this.alerts(50) };
  }

  // === internals ==========================================================

  /**
   * @private Record a signal in its sliding window; raise + persist an alert when the threshold for
   * the type is crossed within the window.
   */
  _signal(type, key, severity, message, ctx) {
    const now = this.clock();
    const wkey = `${type}|${key ?? "global"}`;
    const times = (this._windows.get(wkey) ?? []).filter((t) => now - t < this.windowMs);
    times.push(now);
    this._windows.set(wkey, times);

    const threshold = this.thresholds[type] ?? 1;
    if (times.length < threshold) return null;

    const alert = {
      alertId: this.idGenerator(),
      alertType: type,
      severity,
      message,
      subject: key ?? null,
      count: times.length,
      at: now,
      details: sanitize(ctx),
    };
    this._alerts.push(alert);
    if (this._alerts.length > this._maxAlerts) this._alerts.splice(0, this._alerts.length - this._maxAlerts);
    this._windows.set(wkey, []); // reset the window after alerting (avoid a per-event storm)

    this.metrics?.increment(Metric.ALERT_TOTAL, 1, { type });
    this.events.emit(HardeningEventType.ALERT_RAISED, { alertType: type, severity, subject: key, count: alert.count, reason: message });
    if (this.sink?.record) {
      try {
        this.sink.record(alert);
      } catch {
        /* persistence is best-effort */
      }
    }
    return alert;
  }
}

/** Strip anything that isn't a plain scalar/id from a signal context (defensive, low-cardinality). */
function sanitize(ctx = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (["subject", "requester", "targetUser", "deviceId", "planId", "subsystem", "route", "reason"].includes(k) && (typeof v === "string" || typeof v === "number")) {
      out[k] = v;
    }
  }
  return out;
}

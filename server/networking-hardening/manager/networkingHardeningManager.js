/**
 * @module networking-hardening/manager
 *
 * The **Networking Hardening Manager** — the single object that ties the production-hardening
 * components together and is fed by the Layer-6 subsystems: a {@link module:networking-hardening/observability
 * metrics registry}, a {@link module:networking-hardening/monitoring monitor}, a
 * {@link module:networking-hardening/recovery recovery coordinator}, a {@link module:networking-hardening/ratelimit
 * rate limiter}, and an idempotency store. It exposes a consolidated **health** view + convenience
 * recorders so a controller (or another layer) can wire observability in one place.
 *
 * @security Read/observe only. Everything it exposes is METADATA + numeric aggregates — never key
 * material. Feeding it must never block or break the networking path.
 *
 * @example
 * ```js
 * const hardening = new NetworkingHardeningManager({ sink });
 * const stop = hardening.metrics.startTimer(Metric.DISCOVERY_LATENCY);
 * // ... discovery ...
 * stop(); hardening.metrics.recordDiscovery(true);
 * hardening.health(); // { status, metrics, monitor, freeze }
 * ```
 */

import { NetworkingMetrics } from "../observability/metrics.js";
import { NetworkMonitor } from "../monitoring/networkMonitor.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { RateLimiter } from "../ratelimit/rateLimiter.js";
import { IdempotencyStore } from "../consistency/consistency.js";
import { HardeningEventBus } from "../events/events.js";
import { protocolManifest } from "../freeze/protocolFreeze.js";
import { auditNetworkingApis } from "../security/securityAudit.js";
import { HealthStatus, HardeningEventType } from "../types/types.js";

export class NetworkingHardeningManager {
  /**
   * @param {object} [deps]
   * @param {HardeningEventBus} [deps.events] @param {NetworkingMetrics} [deps.metrics]
   * @param {NetworkMonitor} [deps.monitor] @param {RecoveryCoordinator} [deps.recovery]
   * @param {RateLimiter} [deps.rateLimiter] @param {IdempotencyStore} [deps.idempotency]
   * @param {object} [deps.sink] alert persistence `{ record(alert) }`
   * @param {() => number} [deps.clock] @param {object} [deps.recoveryHooks]
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.metrics = deps.metrics ?? new NetworkingMetrics();
    this.monitor = deps.monitor ?? new NetworkMonitor({ events: this.events, metrics: this.metrics, clock: this.clock, sink: deps.sink });
    this.recovery = deps.recovery ?? new RecoveryCoordinator({ events: this.events, metrics: this.metrics, clock: this.clock, hooks: deps.recoveryHooks });
    this.rateLimiter = deps.rateLimiter ?? new RateLimiter({ events: this.events, metrics: this.metrics, clock: this.clock });
    this.idempotency = deps.idempotency ?? new IdempotencyStore({ clock: this.clock });
    this._lastHealth = HealthStatus.HEALTHY;
  }

  /**
   * Wire the manager to a subsystem's event bus so a failed operation feeds the monitor + metrics.
   * @param {string} subsystem a label (e.g. "discovery")
   * @param {{ on: (t:string, h:Function)=>(()=>void) }} bus @param {{ failEvent?: string }} map
   * @returns {() => void} unsubscribe
   */
  wire(subsystem, bus, map = {}) {
    const offs = [];
    if (map.failEvent) {
      offs.push(bus.on(map.failEvent, (e) => {
        this.metrics.recordDiscovery(false);
        this.monitor.onDiscoveryFailure({ subject: e?.requester ?? e?.userId ?? subsystem, subsystem });
      }));
    }
    return () => offs.forEach((off) => off && off());
  }

  /** A consolidated health snapshot for a `/health` check + dashboards. */
  health() {
    const report = this.monitor.report();
    const status = report.health;
    if (status !== this._lastHealth) {
      this.events.emit(HardeningEventType.HEALTH_CHANGED, { reason: status, details: { from: this._lastHealth } });
      this._lastHealth = status;
    }
    return {
      status,
      metrics: {
        discoverySuccessRate: this.metrics.discoverySuccessRate(),
        snapshot: this.metrics.snapshot(),
      },
      monitor: { health: report.health, counts: report.counts, recentAlerts: report.alerts.length },
      freeze: { frozen: protocolManifest.frozen, controlPlaneVersion: protocolManifest.versions.controlPlane },
      security: auditNetworkingApis(),
      at: this.clock(),
    };
  }

  /** The metrics in Prometheus exposition format (for a `/metrics` scrape). */
  prometheus() {
    return this.metrics.prometheus();
  }

  /** The frozen protocol manifest (for docs + Layer-7 compatibility checks). */
  manifest() {
    return protocolManifest;
  }
}

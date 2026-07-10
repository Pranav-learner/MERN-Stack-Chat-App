/**
 * @module shs/hardening/observability/healthMonitor
 *
 * Protocol health monitoring. Subscribes to the existing SHS / key-agreement /
 * session / hardening event buses, feeds a {@link MetricsCollector}, and derives a
 * rolling **protocol health** verdict (healthy / degraded / unhealthy) from failure
 * and security-event rates. This is the "is the protocol OK right now?" summary a
 * future monitoring system polls.
 *
 * @security Aggregate signals only. Wiring is best-effort and never affects protocol
 * correctness.
 */

import { MetricsCollector, Metric } from "./metrics.js";
import { HealthStatus } from "../types.js";

export class HealthMonitor {
  /**
   * @param {object} [deps]
   * @param {MetricsCollector} [deps.metrics]
   * @param {{ degradedFailureRate?: number, unhealthyFailureRate?: number, minSamples?: number }} [deps.thresholds]
   */
  constructor(deps = {}) {
    this.metrics = deps.metrics ?? new MetricsCollector();
    this.thresholds = {
      degradedFailureRate: deps.thresholds?.degradedFailureRate ?? 0.2,
      unhealthyFailureRate: deps.thresholds?.unhealthyFailureRate ?? 0.5,
      minSamples: deps.thresholds?.minSamples ?? 5,
    };
    this._unsubscribers = [];
  }

  /**
   * Wire this monitor to event buses. Each argument is optional.
   * @param {{ handshakes?: {on:Function}, keyAgreement?: {on:Function}, sessions?: {on:Function}, hardening?: {on:Function} }} buses
   * @returns {this}
   */
  attach(buses = {}) {
    const m = this.metrics;
    if (buses.handshakes) {
      this._sub(buses.handshakes, "handshake.started", () => m.increment(Metric.HANDSHAKES_STARTED));
      this._sub(buses.handshakes, "handshake.completed", () => m.increment(Metric.HANDSHAKES_COMPLETED));
      this._sub(buses.handshakes, "handshake.failed", () => m.increment(Metric.HANDSHAKES_FAILED));
      this._sub(buses.handshakes, "handshake.restarted", () => m.increment(Metric.RETRIES));
    }
    if (buses.keyAgreement) {
      this._sub(buses.keyAgreement, "keyagreement.completed", () => m.increment(Metric.KEY_AGREEMENTS_COMPLETED));
      this._sub(buses.keyAgreement, "keyagreement.failed", () => m.increment(Metric.KEY_AGREEMENTS_FAILED));
    }
    if (buses.sessions) {
      this._sub(buses.sessions, "session.created", () => m.increment(Metric.SESSIONS_CREATED));
      this._sub(buses.sessions, "session.expired", () => m.increment(Metric.SESSIONS_EXPIRED));
    }
    if (buses.hardening) {
      this._sub(buses.hardening, "hardening.replay_detected", () => m.increment(Metric.REPLAYS_DETECTED));
      this._sub(buses.hardening, "hardening.downgrade_blocked", () => m.increment(Metric.DOWNGRADES_BLOCKED));
      this._sub(buses.hardening, "hardening.integrity_violation", () => m.increment(Metric.INTEGRITY_VIOLATIONS));
      this._sub(buses.hardening, "hardening.recovery_succeeded", () => m.increment(Metric.RECOVERIES));
    }
    return this;
  }

  /** Detach all subscriptions. */
  detach() {
    for (const off of this._unsubscribers) off();
    this._unsubscribers = [];
  }

  /**
   * The current protocol health verdict.
   * @returns {{ status: string, failureRate: number, samples: number, metrics: object, signals: object }}
   */
  health() {
    const m = this.metrics;
    const started = m.counter(Metric.HANDSHAKES_STARTED);
    const completed = m.counter(Metric.HANDSHAKES_COMPLETED);
    const failed = m.counter(Metric.HANDSHAKES_FAILED);
    const finished = completed + failed;
    const failureRate = finished > 0 ? failed / finished : 0;

    const securitySignals =
      m.counter(Metric.REPLAYS_DETECTED) + m.counter(Metric.DOWNGRADES_BLOCKED) + m.counter(Metric.INTEGRITY_VIOLATIONS);

    let status = HealthStatus.HEALTHY;
    if (finished >= this.thresholds.minSamples) {
      if (failureRate >= this.thresholds.unhealthyFailureRate) status = HealthStatus.UNHEALTHY;
      else if (failureRate >= this.thresholds.degradedFailureRate) status = HealthStatus.DEGRADED;
    }
    // A burst of security events degrades health regardless of failure rate.
    if (status === HealthStatus.HEALTHY && securitySignals > 0) status = HealthStatus.DEGRADED;

    return {
      status,
      failureRate,
      samples: finished,
      signals: {
        started,
        completed,
        failed,
        replaysDetected: m.counter(Metric.REPLAYS_DETECTED),
        downgradesBlocked: m.counter(Metric.DOWNGRADES_BLOCKED),
        integrityViolations: m.counter(Metric.INTEGRITY_VIOLATIONS),
        recoveries: m.counter(Metric.RECOVERIES),
      },
      metrics: m.snapshot(),
    };
  }

  /** @private */
  _sub(bus, type, handler) {
    const off = bus.on(type, handler);
    if (typeof off === "function") this._unsubscribers.push(off);
  }
}

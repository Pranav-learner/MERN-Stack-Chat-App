/**
 * @module fabric-reliability/monitoring/monitor
 *
 * The **Fabric Monitor** (STEP 4 + 6) — the continuous observability + alerting loop. It attaches to the
 * frozen lower-layer event buses (Sprint 1 Fabric / Sprint 2 Adaptive / Sprint 3 Optimization) WITHOUT
 * importing them (it routes by the event's `type` prefix), turning their events into metrics; it runs a
 * periodic sweep that drives the recovery stall-sweep + a fresh health check + raises alerts on threshold
 * breaches; and it keeps a bounded ring of recent alerts. The sweep timer is `unref`'d so it never keeps
 * the process alive — the same pattern as every prior layer's stall monitor.
 *
 * @security Reasons over event classifications + metric numbers + health statuses only. No content.
 */

import { HealthStatus, AlertSeverity, MAX_ALERTS, ReliabilityEventType, ComponentKind } from "../types/types.js";

export class FabricMonitor {
  /**
   * @param {object} deps
   * @param {import("./metrics.js").FabricMetrics} deps.metrics @param {import("../health/healthManager.js").HealthManager} deps.health
   * @param {import("../recovery/recoveryEngine.js").RecoveryEngine} [deps.recovery]
   * @param {import("../events/events.js").FabricReliabilityEventBus} [deps.events]
   * @param {number} [deps.intervalMs] sweep interval @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.metrics = deps.metrics;
    this.health = deps.health;
    this.recovery = deps.recovery ?? null;
    this.events = deps.events ?? null;
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.clock = deps.clock ?? (() => Date.now());
    this._alerts = [];
    this._timer = null;
    this._unsubs = [];
  }

  /** Attach to a lower-layer event bus — routes events to metrics by `type` prefix (no hard import). */
  attachBus(bus) {
    if (!bus?.on) return this;
    this._unsubs.push(bus.on("*", (e) => this._observe(e)));
    return this;
  }

  /** Route one observed event into metrics + alerts. */
  _observe(event) {
    const t = event?.type ?? "";
    try {
      if (t.endsWith("communication_requested")) this.metrics.incr("fabric_communication_throughput_total", 1, { kind: "request" });
      else if (t === "optimization.qos_evaluated" && event.qosClass) this.metrics.recordQoS(event.qosClass);
      else if (t === "optimization.workload_balanced" && typeof event.totalDepth === "number") this.metrics.setQueueDepth(event.totalDepth);
      else if (t === ReliabilityEventType.CIRCUIT_OPENED) {
        this.metrics.setCircuitState(event.name, 1);
        this.raiseAlert(AlertSeverity.WARNING, "circuit-opened", { name: event.name });
        this.health?.setComponent(ComponentKind.SUBSYSTEM_REGISTRY, HealthStatus.DEGRADED, { circuit: event.name });
      } else if (t === ReliabilityEventType.CIRCUIT_CLOSED) {
        this.metrics.setCircuitState(event.name, 0);
        this.health?.setComponent(ComponentKind.SUBSYSTEM_REGISTRY, HealthStatus.HEALTHY, { circuit: event.name });
      } else if (t === ReliabilityEventType.OPERATION_FAILED) this.metrics.incr("fabric_operation_failures_total", 1, { kind: event.kind ?? "?" });
    } catch {
      /* observation must never throw */
    }
  }

  /** Raise + store a bounded alert; emit ALERT_RAISED. */
  raiseAlert(severity, code, detail = {}) {
    const alert = { severity, code, detail, at: new Date(this.clock()).toISOString() };
    this._alerts.push(alert);
    if (this._alerts.length > MAX_ALERTS) this._alerts.shift();
    this.events?.emit(ReliabilityEventType.ALERT_RAISED, { severity, code, detail });
    return alert;
  }

  /** Recent alerts (newest last). */
  alerts({ limit = 100 } = {}) {
    return this._alerts.slice(-limit);
  }

  /** One monitoring sweep — recovery stall-sweep + health check + threshold alerts. */
  async tick() {
    const out = { at: new Date(this.clock()).toISOString() };
    if (this.recovery) {
      out.recovery = await this.recovery.recoverInterrupted().catch(() => ({ scanned: 0, recovered: 0, abandoned: 0 }));
      if (out.recovery.abandoned > 0) this.raiseAlert(AlertSeverity.CRITICAL, "operations-abandoned", { count: out.recovery.abandoned });
      this.metrics.setGauge("fabric_stalled_recovered_total", out.recovery.recovered);
    }
    if (this.health) {
      out.health = await this.health.check().catch(() => ({ status: HealthStatus.UNKNOWN, components: [] }));
      if (out.health.status === HealthStatus.UNHEALTHY) this.raiseAlert(AlertSeverity.CRITICAL, "fabric-unhealthy", { components: out.health.components.filter((c) => c.status === HealthStatus.UNHEALTHY).map((c) => c.component) });
    }
    return out;
  }

  /** Start the periodic sweep (unref'd — never keeps the process alive). */
  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
    if (typeof this._timer?.unref === "function") this._timer.unref();
    return this;
  }

  /** Stop the sweep + detach from buses. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const u of this._unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this._unsubs = [];
    return this;
  }
}

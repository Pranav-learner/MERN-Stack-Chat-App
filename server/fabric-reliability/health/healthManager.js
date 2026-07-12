/**
 * @module fabric-reliability/health/healthManager
 *
 * The **Health Manager** (STEP 4) — continuously tracks the health of every Fabric component (fabric,
 * decision engine, capability engine, routing, scheduler, QoS, resource manager, repository, subsystem
 * registry, execution, recovery) and rolls them up to an overall status. Health comes from two sources:
 * PROBES (pull — run on demand) and directly-SET component statuses (push — the monitor sets these from
 * live event/metric signals). It also serves **readiness** (can the platform accept traffic?) and
 * **liveness** (is the process up?) for operational tooling (STEP 11).
 *
 * @security Reasons over component statuses + control-plane detail + recovery/metric numbers only.
 */

import { ProbeRegistry } from "./probes.js";
import { HealthStatus, HEALTH_RANK, ALL_COMPONENT_KINDS, ComponentKind, ReliabilityEventType } from "../types/types.js";

export class HealthManager {
  /**
   * @param {object} [deps]
   * @param {ProbeRegistry} [deps.probes] @param {import("../events/events.js").FabricReliabilityEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.probes = deps.probes ?? new ProbeRegistry();
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    /** @type {Map<string, object>} component → { status, detail, updatedAt } (push source) */
    this._components = new Map();
    this._live = true;
  }

  /** Register a health probe (pull source). */
  registerProbe(component, name, fn) {
    this.probes.register(component, name, fn);
    return this;
  }

  /** Directly set a component's health (push source — the monitor uses this). Emits on change. */
  setComponent(component, status, detail = null) {
    const prev = this._components.get(component)?.status;
    this._components.set(component, { status, detail, updatedAt: new Date(this.clock()).toISOString() });
    if (prev && prev !== status) this.events?.emit(ReliabilityEventType.HEALTH_CHANGED, { component, from: prev, to: status });
    return this;
  }

  /** Mark the process not-live (a fatal, unrecoverable condition — liveness fails). */
  setDead(reason) {
    this._live = false;
    this._deadReason = reason;
  }

  /**
   * Run all probes + merge with pushed component statuses → per-component health + overall rollup.
   * @returns {Promise<object>} `{ status, components, at }`
   */
  async check() {
    const probeResults = await this.probes.run();
    const byComponent = new Map();
    // start from pushed statuses
    for (const [component, s] of this._components) byComponent.set(component, { component, status: s.status, detail: s.detail });
    // merge probe results (worst wins per component)
    for (const r of probeResults) {
      const existing = byComponent.get(r.component);
      if (!existing || HEALTH_RANK[r.status] > HEALTH_RANK[existing.status]) byComponent.set(r.component, { component: r.component, status: r.status, detail: r.detail });
    }
    const components = [...byComponent.values()];
    const status = rollup(components.map((c) => c.status));
    return { status, components, at: new Date(this.clock()).toISOString() };
  }

  /** Readiness — the platform can accept traffic (no component is UNHEALTHY). */
  async readiness() {
    const h = await this.check();
    const ready = h.status !== HealthStatus.UNHEALTHY && this._live;
    return { ready, status: h.status, components: h.components };
  }

  /** Liveness — the process is up (a fatal condition flips this). */
  liveness() {
    return { live: this._live, reason: this._deadReason ?? null, at: new Date(this.clock()).toISOString() };
  }

  /** The overall rolled-up status (probes + pushed) without the component detail. */
  async overall() {
    return (await this.check()).status;
  }
}

/** Roll a set of component statuses up to one overall status (worst wins; empty → UNKNOWN). */
export function rollup(statuses) {
  if (!statuses || statuses.length === 0) return HealthStatus.UNKNOWN;
  let worst = HealthStatus.HEALTHY;
  for (const s of statuses) if (HEALTH_RANK[s] > HEALTH_RANK[worst]) worst = s;
  return worst;
}

export { ComponentKind, ALL_COMPONENT_KINDS };

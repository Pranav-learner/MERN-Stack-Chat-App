/**
 * @module fabric-reliability/health/probes
 *
 * A **health-probe registry** (STEP 4) — named checks that report a {@link HealthStatus} for a Fabric
 * {@link ComponentKind}. A probe is a small function returning `{ status, detail }`; the registry runs
 * them all (isolating failures — a throwing probe reports UNHEALTHY rather than crashing the check). This
 * is the extensible seam a deployment adds custom liveness/readiness checks to.
 *
 * @security Probes return statuses + control-plane detail only. No content.
 */

import { HealthStatus } from "../types/types.js";

export class ProbeRegistry {
  constructor() {
    this._probes = []; // { name, component, fn }
  }

  /** Register a probe. `fn()` returns `{ status, detail? }` (sync or async). @returns {this} */
  register(component, name, fn) {
    this._probes.push({ component, name, fn });
    return this;
  }

  /** All registered probe descriptors. */
  list() {
    return this._probes.map(({ component, name }) => ({ component, name }));
  }

  /** Run every probe, isolating failures. @returns {Promise<object[]>} `[{ component, name, status, detail }]` */
  async run() {
    return Promise.all(
      this._probes.map(async ({ component, name, fn }) => {
        try {
          const out = (await fn()) ?? {};
          return { component, name, status: out.status ?? HealthStatus.HEALTHY, detail: out.detail ?? null };
        } catch (error) {
          return { component, name, status: HealthStatus.UNHEALTHY, detail: { error: error?.code ?? error?.message ?? "probe-failed" } };
        }
      }),
    );
  }
}

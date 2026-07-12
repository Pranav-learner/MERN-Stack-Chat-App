/**
 * @module fabric-reliability/api
 *
 * The stable **Fabric Reliability service facade** the HTTP controller delegates to (STEP 11). Wraps the
 * {@link FabricReliabilityManager} with a flat operational surface: run a resilient operation, health /
 * readiness / liveness checks, diagnostics overview, metrics (JSON + Prometheus), per-operation
 * inspection, runtime status, and the frozen architecture manifest. This is the boundary operational
 * tooling programs against.
 *
 * @security Every method returns a control-plane view (statuses + numbers + ids). No content.
 */

import { getProtocolFreeze } from "../freeze/protocolFreeze.js";

export function createReliabilityApi(manager) {
  return {
    /** Run a fabric operation with full resilience (the production wrapper). */
    run: (kind, executor, opts) => manager.run(kind, executor, opts),

    /** Liveness — is the process up? */
    live: () => manager.liveness(),
    /** Readiness — can the platform accept traffic? */
    ready: () => manager.readiness(),
    /** Overall + per-component health. */
    health: () => manager.healthCheck(),
    /** Full diagnostics overview. */
    diagnostics: () => manager.diagnosticsOverview(),
    /** Metrics snapshot (JSON). */
    metrics: () => manager.metricsSnapshot(),
    /** Metrics in Prometheus exposition format. */
    prometheus: () => manager.prometheus(),
    /** Inspect a single operation (checkpoint + audit). */
    inspectOperation: ({ operationId }) => manager.inspectOperation(operationId),
    /** Runtime status / statistics. */
    status: () => manager.status(),
    /** The frozen architecture manifest (stable APIs + extension points). */
    freeze: () => getProtocolFreeze(),
  };
}

/**
 * @module fabric-reliability/diagnostics/diagnostics
 *
 * **Diagnostics aggregation** (STEP 4 + 11) — a single read surface that composes the reliability layer's
 * observability sources into an operator-friendly picture: overall + per-component health, the metrics
 * snapshot, circuit-breaker + bulkhead states, recovery statistics, recent alerts, and per-operation
 * inspection (an operation's checkpoint + audit trail). This is what the diagnostics / inspection APIs
 * (STEP 11) return.
 *
 * @security Composes control-plane statuses + numbers + audit records only. No content.
 */

export class Diagnostics {
  /**
   * @param {object} deps
   * @param {import("../health/healthManager.js").HealthManager} deps.health
   * @param {import("../monitoring/metrics.js").FabricMetrics} deps.metrics
   * @param {import("../monitoring/monitor.js").FabricMonitor} [deps.monitor]
   * @param {import("../recovery/recoveryEngine.js").RecoveryEngine} [deps.recovery]
   * @param {import("../circuit-breaker/circuitBreaker.js").CircuitBreakerRegistry} [deps.circuits]
   * @param {import("../retry/bulkhead.js").BulkheadRegistry} [deps.bulkheads]
   * @param {object} [deps.repo] operations + audit stores for per-operation inspection
   */
  constructor(deps = {}) {
    this.health = deps.health;
    this.metrics = deps.metrics;
    this.monitor = deps.monitor ?? null;
    this.recovery = deps.recovery ?? null;
    this.circuits = deps.circuits ?? null;
    this.bulkheads = deps.bulkheads ?? null;
    this.repo = deps.repo ?? null;
  }

  /** The full platform diagnostics snapshot. */
  async overview() {
    return {
      health: await this.health.check(),
      metrics: this.metrics.snapshot(),
      circuits: this.circuits?.stats() ?? [],
      bulkheads: this.bulkheads?.stats() ?? [],
      recovery: this.recovery?.stats() ?? null,
      alerts: this.monitor?.alerts({ limit: 25 }) ?? [],
    };
  }

  /** Inspect a single operation — its checkpoint + audit trail. */
  async inspectOperation(operationId) {
    const [operation, audit] = await Promise.all([this.repo?.operations?.findById?.(operationId) ?? null, this.repo?.audit?.listByOperation?.(operationId) ?? []]);
    return { operationId, operation, audit };
  }
}

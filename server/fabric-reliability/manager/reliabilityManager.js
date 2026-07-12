/**
 * @module fabric-reliability/manager/reliabilityManager
 *
 * The **Fabric Reliability Manager** — the reusable production wrapper that makes ANY fabric control-plane
 * operation reliable. Its one method, `run(kind, executor, opts)`, composes every resilience pattern in a
 * single, ordered pipeline:
 *
 *   security validate (authz + replay + audit) → circuit-breaker gate → bulkhead isolation →
 *   retry (backoff + failure classification) → timeout → [execute] → on success: metrics + checkpoint
 *   complete; on failure: classify → trip breaker → RECOVER (resume / replan) → else GRACEFULLY DEGRADE.
 *
 * It embeds NO lower-layer logic — the `executor` closure is the actual fabric/adaptive/optimization call.
 * It hardens the CONTROL PLANE without modifying any lower layer; a deployment wraps a call site with it
 * (see `integration/fabricIntegration.js`) and the operation gains circuit breaking, bulkheads, timeouts,
 * retries, recovery, graceful degradation, metrics, tracing, and an audit trail — all configurable.
 *
 * @performance Bounded overhead per call: one security check, one breaker check, one bulkhead slot, one
 * timer, and O(1) metric records. Concurrency is isolated per compartment.
 *
 * @security Reasons over operation CONTROL-PLANE metadata only — kind, ids, states, latencies, failure
 * classes. Never content/keys; the no-content scan guards every persisted audit record.
 *
 * @example
 * ```js
 * const rm = new FabricReliabilityManager({ ...createInMemoryReliabilityRepository() });
 * const r = await rm.run("communication-execute", async () => fabricApi.execute(req, { callerId }), { callerId, ownerId: callerId, compartment: "messaging" });
 * // r.ok, r.result, r.latencyMs, r.attempts, r.recovery?
 * ```
 */

import { CircuitBreakerRegistry } from "../circuit-breaker/circuitBreaker.js";
import { BulkheadRegistry } from "../retry/bulkhead.js";
import { RetryPolicy } from "../retry/retryPolicy.js";
import { FailureClassifier } from "../retry/failureClassifier.js";
import { TimeoutPolicy, withTimeout } from "../timeout/timeout.js";
import { RecoveryEngine } from "../recovery/recoveryEngine.js";
import { GracefulDegradation } from "../recovery/degradation.js";
import { HealthManager } from "../health/healthManager.js";
import { FabricMetrics } from "../monitoring/metrics.js";
import { FabricMonitor } from "../monitoring/monitor.js";
import { Tracer } from "../monitoring/tracing.js";
import { Diagnostics } from "../diagnostics/diagnostics.js";
import { SecurityValidator } from "../validators/securityValidator.js";
import { FabricReliabilityEventBus } from "../events/events.js";
import { validateRepository, validateConfig, validateOperationKind, assertNoContent } from "../validators/validators.js";
import { toResultView, toHealthView, toDiagnosticsView, toOperationView } from "../serializers/serializers.js";
import { FabricError } from "../_fabric.js";
import { OperationState, RecoveryOutcome, FailureClass, FabricOperationKind, ReliabilityEventType, RELIABILITY_FRAMEWORK, RELIABILITY_SCHEMA_VERSION, RELIABILITY_LAYER, RELIABILITY_SPRINT, ComponentKind, HealthStatus } from "../types/types.js";

let OP_SEQ = 0;
const genId = () => `op_${(OP_SEQ = (OP_SEQ + 1) % Number.MAX_SAFE_INTEGER)}`;

/** Kind → the specific latency metric recorder. */
const KIND_LATENCY = Object.freeze({
  [FabricOperationKind.DECISION]: "recordDecisionLatency",
  [FabricOperationKind.ROUTE_EVALUATE]: "recordRoutingLatency",
  [FabricOperationKind.SCHEDULE]: "recordSchedulerLatency",
  [FabricOperationKind.POLICY_EVALUATE]: "recordPolicyEval",
});

export class FabricReliabilityManager {
  /**
   * @param {object} deps repository bundle (`operations`, `health`, `audit`) + optional overrides
   * @param {object} [deps.config] `{ circuit, retry, timeout, bulkhead, recovery }`
   * @param {FabricReliabilityEventBus} [deps.events] @param {object} [deps.logger] structured-log sink
   * @param {object} [deps.tracer] external tracer delegate @param {object} [deps.security] `{ authorizer, rateLimiter }`
   * @param {(ms:number)=>Promise<void>} [deps.sleep] injectable retry sleep @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    validateRepository(deps);
    this.repo = { operations: deps.operations, health: deps.health, audit: deps.audit };
    this.config = validateConfig(deps.config ?? {});
    this.events = deps.events ?? new FabricReliabilityEventBus();
    this.clock = deps.clock ?? (() => Date.now());

    this.classifier = new FailureClassifier();
    this.circuits = new CircuitBreakerRegistry({ defaults: this.config.circuit, events: this.events, clock: this.clock });
    this.bulkheads = new BulkheadRegistry({ defaults: this.config.bulkhead, events: this.events });
    this.retry = new RetryPolicy({ ...(this.config.retry ?? {}), classifier: this.classifier, events: this.events, sleep: deps.sleep });
    this.timeouts = new TimeoutPolicy(this.config.timeout);
    this.degradation = new GracefulDegradation({ events: this.events });
    this.recovery = new RecoveryEngine({ operations: this.repo.operations, degradation: this.degradation, events: this.events, config: this.config.recovery, clock: this.clock });

    this.metrics = new FabricMetrics({ clock: this.clock, logger: deps.logger });
    this.tracer = new Tracer({ delegate: deps.tracer, sink: (r) => this.metrics.log("trace", "span", r), clock: this.clock });
    this.health = new HealthManager({ events: this.events, clock: this.clock });
    this.monitor = new FabricMonitor({ metrics: this.metrics, health: this.health, recovery: this.recovery, events: this.events, clock: this.clock });
    this.security = new SecurityValidator({ authorizer: deps.security?.authorizer, rateLimiter: deps.security?.rateLimiter, audit: this.repo.audit, events: this.events, clock: this.clock });
    this.diagnostics = new Diagnostics({ health: this.health, metrics: this.metrics, monitor: this.monitor, recovery: this.recovery, circuits: this.circuits, bulkheads: this.bulkheads, repo: this.repo });

    this._registerDefaultProbes();
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /** Attach the monitor to a lower-layer event bus (Fabric / Adaptive / Optimization). */
  attachBus(bus) {
    this.monitor.attachBus(bus);
    return this;
  }

  // === the production wrapper ================================================

  /**
   * Run a fabric operation with full production resilience + recovery + observability + security.
   * @param {string} kind a {@link FabricOperationKind}
   * @param {(ctx: object) => Promise<any>} executor the actual fabric call (receives `{ attempt, checkpoint, operationId }`)
   * @param {object} [opts] `{ operationId, compartment, callerId, ownerId, idempotencyKey, allowServer, checkpointData, throwOnFail }`
   * @returns {Promise<import("../types/types.js").ResilientResult>}
   */
  async run(kind, executor, opts = {}) {
    validateOperationKind(kind);
    const operationId = opts.operationId ?? genId();
    const compartment = opts.compartment ?? kind;
    const span = this.tracer.startSpan(`fabric.${kind}`, { operationId, kind });
    const start = this.clock();

    // 1) security: authorization + replay + audit
    try {
      this.security.validate({ kind, operationId, callerId: opts.callerId, ownerId: opts.ownerId ?? opts.senderId, idempotencyKey: opts.idempotencyKey, allowServer: opts.allowServer });
    } catch (error) {
      span.end("denied");
      this.events.emit(ReliabilityEventType.OPERATION_ABORTED, { operationId, kind, reason: error.reason });
      if (opts.throwOnFail !== false) throw error;
      return this._result({ ok: false, operationId, kind, state: OperationState.ABORTED, error: toErrorInfo(error), attempts: 0, latencyMs: 0 });
    }

    this.events.emit(ReliabilityEventType.OPERATION_STARTED, { operationId, kind });

    // 2) circuit-breaker gate
    const breaker = this.circuits.get(`${kind}:${compartment}`);
    try {
      breaker.assertPass();
    } catch (error) {
      this.metrics.recordOperation(kind, { ok: false, failureClass: FailureClass.RESOURCE });
      this.events.emit(ReliabilityEventType.OPERATION_ABORTED, { operationId, kind, reason: "circuit-open" });
      span.end("aborted");
      const degraded = this.degradation.degrade(kind, error, { operationId });
      if (opts.throwOnFail) throw error;
      return this._result({ ok: false, operationId, kind, state: OperationState.ABORTED, error: toErrorInfo(error), degraded, attempts: 0, latencyMs: this.clock() - start });
    }

    // 3) checkpoint + bulkhead + retry + timeout
    const bulkhead = this.bulkheads.get(compartment);
    const timeoutMs = this.timeouts.forKind(kind);
    const checkpoint = await this.recovery.begin(operationId, kind, opts.checkpointData ?? {});
    let attempts = 0;

    try {
      const { result } = await bulkhead.run(() =>
        this.retry.run(
          async (attempt) => {
            attempts = attempt;
            if (attempt > 1) await this.recovery.touch(operationId, { attempt });
            return await withTimeout(() => executor({ attempt, checkpoint, operationId }), timeoutMs, { label: kind });
          },
          { operationId, kind },
        ),
      );
      breaker.recordSuccess();
      await this.recovery.complete(operationId);
      const latencyMs = this.clock() - start;
      this._recordLatency(kind, latencyMs);
      this.metrics.recordOperation(kind, { ok: true, latencyMs });
      this.events.emit(ReliabilityEventType.OPERATION_SUCCEEDED, { operationId, kind, latencyMs, attempts });
      await this._audit(operationId, ReliabilityEventType.OPERATION_SUCCEEDED, kind, { detail: { latencyMs, attempts } });
      span.end("ok");
      return this._result({ ok: true, operationId, kind, state: OperationState.SUCCEEDED, result, attempts, latencyMs });
    } catch (error) {
      const failureClass = this.classifier.classify(error);
      breaker.recordFailure(failureClass);
      const latencyMs = this.clock() - start;
      this.metrics.recordOperation(kind, { ok: false, latencyMs, failureClass });
      this.events.emit(failureClass === FailureClass.TIMEOUT ? ReliabilityEventType.OPERATION_TIMED_OUT : ReliabilityEventType.OPERATION_FAILED, { operationId, kind, failureClass });

      // 4) recovery
      const recovered = await this.recovery.recover(operationId, error, { kind, failureClass, executor });
      if (recovered.ok) {
        this.metrics.recordRecovery(true);
        await this._audit(operationId, ReliabilityEventType.RECOVERY_COMPLETED, kind, { detail: { outcome: recovered.outcome } });
        span.end("recovered");
        return this._result({ ok: true, operationId, kind, state: OperationState.RECOVERED, result: recovered.result, attempts, latencyMs: this.clock() - start, recovery: recovered.outcome });
      }
      this.metrics.recordRecovery(false);
      await this._audit(operationId, ReliabilityEventType.OPERATION_FAILED, kind, { detail: { failureClass, recovery: recovered.outcome } });
      span.end("failed");
      if (opts.throwOnFail) throw error;
      const state = recovered.outcome === RecoveryOutcome.GRACEFULLY_FAILED ? OperationState.GRACEFULLY_FAILED : OperationState.FAILED;
      return this._result({ ok: false, operationId, kind, state, error: toErrorInfo(error), degraded: recovered.degraded, attempts, latencyMs, recovery: recovered.outcome });
    }
  }

  // === operational tooling ==================================================

  /** Readiness check (STEP 11) — can the platform accept traffic? */
  readiness() {
    return this.health.readiness();
  }
  /** Liveness check (STEP 11) — is the process up? */
  liveness() {
    return this.health.liveness();
  }
  /** Overall + per-component health (STEP 4). */
  async healthCheck() {
    const h = await this.health.check();
    return toHealthView(h);
  }
  /** Full diagnostics overview (STEP 11). */
  async diagnosticsOverview() {
    return toDiagnosticsView(await this.diagnostics.overview());
  }
  /** Inspect a single operation — checkpoint + audit (STEP 11). */
  async inspectOperation(operationId) {
    return toOperationView(await this.diagnostics.inspectOperation(operationId));
  }
  /** The metrics snapshot / Prometheus / OTel exports (STEP 6). */
  metricsSnapshot() {
    return this.metrics.snapshot();
  }
  prometheus() {
    return this.metrics.prometheus();
  }
  /** Persist the current health as a snapshot (operational history). */
  async recordHealthSnapshot() {
    const h = await this.health.check();
    const snapshot = { status: h.status, components: h.components, metricsDigest: { throughput: this.metrics.snapshot().counters, recovery: this.recovery.stats() }, at: h.at };
    assertNoContent(snapshot);
    await this.repo.health.recordSnapshot(snapshot);
    return snapshot;
  }
  /** Aggregate status / health (STEP 11 runtime statistics). */
  async status() {
    return {
      framework: RELIABILITY_FRAMEWORK,
      layer: RELIABILITY_LAYER,
      sprint: RELIABILITY_SPRINT,
      schemaVersion: RELIABILITY_SCHEMA_VERSION,
      status: "ok",
      health: await this.healthCheck(),
      circuits: this.circuits.stats(),
      bulkheads: this.bulkheads.stats(),
      recovery: this.recovery.stats(),
      security: this.security.stats(),
      metrics: this.metrics.snapshot(),
      at: new Date(this.clock()).toISOString(),
    };
  }

  // === internals ============================================================

  _recordLatency(kind, ms) {
    const fn = KIND_LATENCY[kind];
    if (fn) this.metrics[fn](ms);
  }

  async _audit(operationId, event, kind, extra = {}) {
    try {
      const record = { operationId, event, kind, at: new Date(this.clock()).toISOString(), ...extra };
      assertNoContent(record);
      await this.repo.audit.append(record);
    } catch {
      /* best-effort */
    }
  }

  _result(r) {
    return toResultView(r);
  }

  _registerDefaultProbes() {
    // repository probe — a store method must be callable
    this.health.registerProbe(ComponentKind.REPOSITORY, "operations-store", () => ({ status: typeof this.repo.operations?.findById === "function" ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY }));
    // recovery probe — degrade if operations are being abandoned
    this.health.registerProbe(ComponentKind.RECOVERY, "recovery-stats", () => {
      const s = this.recovery.stats();
      const status = s.abandoned > 0 ? HealthStatus.DEGRADED : HealthStatus.HEALTHY;
      return { status, detail: { abandoned: s.abandoned, resumed: s.resumed } };
    });
    // fabric probe — always healthy unless flagged dead
    this.health.registerProbe(ComponentKind.FABRIC, "liveness", () => ({ status: this.health.liveness().live ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY }));
  }
}

/** Reduce an error to a control-plane-safe info object (uses `note`, never a forbidden `message` key). */
export function toErrorInfo(error) {
  if (error instanceof FabricError || (error && error.code)) return { code: error.code ?? "ERR", reason: error.reason ?? null, failureClass: error.failureClass ?? null, note: error.message ?? null };
  return { code: "ERR_UNKNOWN", reason: "internal-error", failureClass: FailureClass.UNKNOWN, note: error?.message ?? "unknown error" };
}

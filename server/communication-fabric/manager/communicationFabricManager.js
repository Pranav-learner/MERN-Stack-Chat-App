/**
 * @module communication-fabric/manager/communicationFabricManager
 *
 * The **Communication Fabric Manager** (STEP 3) — the single entry point for every communication request
 * and the reusable orchestrator of the whole pipeline. Application code calls exactly one method,
 * `execute(request)`, and the manager runs the frozen sequence:
 *
 *   normalize → validate → authorize → build immutable CONTEXT → evaluate POLICIES →
 *   DECIDE (strategy + route, cached) → PLAN (steps + fallbacks) → ORCHESTRATE (delegate to subsystems) →
 *   track + persist + emit events → return a control-plane result view.
 *
 * The manager ORCHESTRATES but contains NO lower-layer business logic: it never encrypts, transports,
 * fans out, or syncs — it decides WHICH registered subsystem does, and in what order. Every subsystem
 * stays independent + reusable; the Fabric is the coordination seam above them.
 *
 * @performance Decisions are memoized by a context fingerprint (see {@link DecisionCache}); repeat traffic
 * skips the engine + policy fold and re-stamps fresh ids. Context building + planning are pure + O(steps).
 * Concurrent requests are independent (no shared mutable state beyond the bounded cache + repo).
 *
 * @security Reasons over control-plane metadata ONLY. Every persisted artifact (decision, plan, execution,
 * audit) passes a no-content deep scan first, so plaintext / ciphertext / key material can never leak in.
 *
 * @example
 * ```js
 * const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository() });
 * fabric.registerSubsystem(createSubsystemAdapter({ kind: "messaging", handler: sendViaLayer8 }));
 * const result = await fabric.execute({ type: "direct-message", senderId: "alice", recipients: ["bob"] }, { callerId: "alice" });
 * // result.decision.strategy === "direct"; result.status === "completed"
 * ```
 */

import { ContextBuilder } from "../contexts/contextBuilder.js";
import { DecisionEngine } from "../decision-engine/decisionEngine.js";
import { createDecision } from "../decision-engine/communicationDecision.js";
import { PolicyEngine } from "../policies/policyEngine.js";
import { RoutePlanner } from "../routing/routePlanner.js";
import { ExecutionPlanner } from "../planners/executionPlanner.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { createDefaultStrategyRegistry } from "../strategies/index.js";
import { createSubsystemRegistry } from "../registry/subsystemRegistry.js";
import { FabricEventBus } from "../events/events.js";
import { DecisionCache } from "./decisionCache.js";
import { toResultView, toContextView, toDecisionView, toPlanView, toExecutionView } from "../serializers/serializers.js";
import { normalizeCommunicationRequest } from "../dto/dto.js";
import {
  validateRepository,
  validateRequest,
  validateContext,
  validateDecision,
  validateExecutionPlan,
  assertAuthorized,
  assertNoContent,
  validateConfig,
} from "../validators/validators.js";
import { FabricEventType, FABRIC_FRAMEWORK, FABRIC_SCHEMA_VERSION, FABRIC_LAYER, FABRIC_SPRINT, ExecutionStatus } from "../types/types.js";

let REQ_SEQ = 0;

export class CommunicationFabricManager {
  /**
   * @param {object} deps a repository bundle (`decisions`, `plans`, `executions`, `audit`) + optional overrides
   * @param {import("../strategies/strategy.js").StrategyRegistry} [deps.strategyRegistry]
   * @param {import("../registry/subsystemRegistry.js").SubsystemRegistry} [deps.subsystemRegistry]
   * @param {PolicyEngine} [deps.policyEngine] @param {object} [deps.policyConfig]
   * @param {object[]} [deps.decisionRules] @param {FabricEventBus} [deps.events]
   * @param {object} [deps.resolvers] `{ availability, sync, security }` context resolvers
   * @param {object} [deps.config] fabric config (cache bounds)
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   */
  constructor(deps = {}) {
    validateRepository(deps);
    this.repo = { decisions: deps.decisions, plans: deps.plans, executions: deps.executions, audit: deps.audit };
    this.config = validateConfig(deps.config ?? {});
    this.events = deps.events ?? new FabricEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => `req_${reqSeq()}`);

    this.strategyRegistry = deps.strategyRegistry ?? createDefaultStrategyRegistry();
    this.subsystemRegistry = deps.subsystemRegistry ?? createSubsystemRegistry();
    this.policyEngine = deps.policyEngine ?? new PolicyEngine({ config: deps.policyConfig, events: this.events });

    this.contextBuilder = new ContextBuilder({
      clock: this.clock,
      resolveAvailability: deps.resolvers?.availability,
      resolveSync: deps.resolvers?.sync,
      resolveSecurity: deps.resolvers?.security,
    });
    this.decisionEngine = new DecisionEngine({ strategyRegistry: this.strategyRegistry, rules: deps.decisionRules, clock: this.clock, idGenerator: () => `dec_${reqSeq()}` });
    // Sprint 2 seam: a deployment may inject an adaptive route planner (e.g. the scoring-driven
    // AdaptiveRoutePlanner) implementing the same `planRoute(decision, context)` contract. Defaults to the
    // deterministic Sprint-1 planner, so existing behaviour is unchanged.
    this.routePlanner = deps.routePlanner ?? new RoutePlanner({ events: this.events });
    this.executionPlanner = new ExecutionPlanner({ strategyRegistry: this.strategyRegistry, routePlanner: this.routePlanner, events: this.events, clock: this.clock });
    this.orchestrator = new Orchestrator({ registry: this.subsystemRegistry, events: this.events, clock: this.clock });

    this.decisionCache = deps.decisionCache ?? new DecisionCache({ ttlMs: this.config.decisionCacheTtlMs, max: this.config.decisionCacheMax, clock: this.clock });

    this._metrics = { requests: 0, executed: 0, completed: 0, partial: 0, failed: 0, denied: 0, aborted: 0 };
  }

  /** Subscribe to a fabric event (or `"*"`). @returns {() => void} */
  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /** Register a subsystem adapter (STEP 9). The Fabric delegates matching plan steps to it. @returns {this} */
  registerSubsystem(adapter) {
    this.subsystemRegistry.register(adapter);
    return this;
  }

  /** Register an additional policy at runtime (configurable seam). */
  addPolicy(policy) {
    this.policyEngine.addPolicy(policy);
    return this;
  }

  // === the single entry point ================================================

  /**
   * Execute a communication request end-to-end through the Fabric pipeline.
   * @param {import("../types/types.js").CommunicationRequest} request
   * @param {object} [opts]
   * @param {string} [opts.callerId] the authenticated caller (must equal the sender unless allowServer)
   * @param {boolean} [opts.allowServer] permit a trusted server-driven flow (no caller check)
   * @param {boolean} [opts.dryRun] plan only — do NOT orchestrate (returns decision + plan, no execution)
   * @returns {Promise<object>} the result view (decision + plan + execution + status)
   */
  async execute(request, opts = {}) {
    this._metrics.requests++;
    const { context, decision } = await this._decideInternal(request, opts);
    const plan = this.executionPlanner.plan(decision, context);
    validateExecutionPlan(plan);
    assertNoContent(plan);
    await this.repo.plans.create(plan);
    await this._audit(decision.requestId, FabricEventType.EXECUTION_PLANNED, { strategyType: decision.strategyType, route: decision.primaryRoute });

    if (opts.dryRun) {
      return toResultView({ decision, plan, execution: null, context });
    }

    // orchestrate — delegate every step to its registered subsystem
    this._metrics.executed++;
    const execution = await this.orchestrator.execute(plan, context);
    assertNoContent(execution);
    await this.repo.executions.create(execution);
    await this._audit(decision.requestId, execution.status === ExecutionStatus.FAILED ? FabricEventType.EXECUTION_FAILED : FabricEventType.EXECUTION_COMPLETED, { status: execution.status });
    this._tallyExecution(execution.status);

    return toResultView({ decision, plan, execution, context });
  }

  /** Build (but do not act on) the immutable context for a request. STEP 11 "Build Context". */
  async buildContext(request) {
    const req = normalizeCommunicationRequest(request);
    validateRequest(req);
    if (!req.requestId) req.requestId = this.idGenerator();
    const context = this.contextBuilder.build(req);
    validateContext(context);
    this.events.emit(FabricEventType.CONTEXT_BUILT, { requestId: req.requestId, type: req.type, at: this.clock() });
    return toContextView(context);
  }

  /** Evaluate policies for a request without deciding/executing. STEP 11 "Evaluate Policies". */
  async evaluatePolicies(request) {
    const req = normalizeCommunicationRequest(request);
    validateRequest(req);
    if (!req.requestId) req.requestId = this.idGenerator();
    const context = this.contextBuilder.build(req);
    validateContext(context);
    const result = this.policyEngine.evaluate(context, req.policyOverrides);
    return { requestId: req.requestId, ...result };
  }

  /** Produce the decision (strategy + route) without planning/executing. STEP 11 "Get Strategy". */
  async getDecision(request, opts = {}) {
    const { decision } = await this._decideInternal(request, opts);
    return toDecisionView(decision);
  }

  /** Produce the full execution plan without executing (a dry run). STEP 11 "Get Execution Plan". */
  async getExecutionPlan(request, opts = {}) {
    const result = await this.execute(request, { ...opts, dryRun: true });
    return result.plan;
  }

  /** Diagnostics for a request: its stored decision(s), final execution status, and audit trail. STEP 11. */
  async decisionDiagnostics(requestId) {
    const [decisions, audit] = await Promise.all([this.repo.decisions.listByRequest(requestId), this.repo.audit.listByRequest(requestId)]);
    const latest = decisions[decisions.length - 1] ?? null;
    // The audit trail is the request-scoped join key (the plans/executions stores are keyed by plan id);
    // the terminal execution entry carries the final status — sufficient for diagnostics without a scan.
    const terminal = [...audit].reverse().find((a) => a.event === FabricEventType.EXECUTION_COMPLETED || a.event === FabricEventType.EXECUTION_FAILED) ?? null;
    return {
      requestId,
      decisions: decisions.map(toDecisionView),
      latestDecision: latest ? toDecisionView(latest) : null,
      executionStatus: terminal?.status ?? null,
      audit,
    };
  }

  /** Aggregate control-plane health snapshot. STEP 11 "Fabric Health". */
  async health() {
    return {
      framework: FABRIC_FRAMEWORK,
      layer: FABRIC_LAYER,
      sprint: FABRIC_SPRINT,
      schemaVersion: FABRIC_SCHEMA_VERSION,
      status: "ok",
      strategies: this.strategyRegistry.types(),
      subsystems: this.subsystemRegistry.describe(),
      policies: this.policyEngine.policySet.ids(),
      decisionCache: this.decisionCache.stats(),
      metrics: { ...this._metrics },
      at: new Date(this.clock()).toISOString(),
    };
  }

  // === internals =============================================================

  /** Shared "up to and including the decision" pipeline, with decision caching. */
  async _decideInternal(request, opts = {}) {
    const req = normalizeCommunicationRequest(request);
    validateRequest(req);
    if (!opts.allowServer || opts.callerId != null) assertAuthorized(req, opts.callerId, { allowServer: opts.allowServer });
    if (!req.requestId) req.requestId = this.idGenerator();

    this.events.emit(FabricEventType.COMMUNICATION_REQUESTED, { requestId: req.requestId, type: req.type, at: this.clock() });
    await this._audit(req.requestId, FabricEventType.COMMUNICATION_REQUESTED, { detail: { type: req.type, conversation: req.conversationType } });

    const context = this.contextBuilder.build(req);
    validateContext(context);
    this.events.emit(FabricEventType.CONTEXT_BUILT, { requestId: req.requestId, at: this.clock() });

    // policy fold (enforces denials)
    const policyResult = this.policyEngine.enforce(context, req.policyOverrides);

    // decision (cache the template; re-stamp fresh ids per request)
    const cacheKey = DecisionCache.keyFor(context, req.policyOverrides);
    let decision;
    const cachedTemplate = this.decisionCache.get(cacheKey);
    if (cachedTemplate) {
      decision = createDecision({ ...cachedTemplate, decisionId: `dec_${reqSeq()}`, requestId: req.requestId, createdAt: new Date(this.clock()).toISOString() });
    } else {
      decision = this.decisionEngine.decide(context, { policyResult, decisionId: `dec_${reqSeq()}` });
      // store a template without the per-request identity/timestamp
      const { decisionId, requestId, createdAt, version, schemaVersion, ...template } = decision;
      this.decisionCache.set(cacheKey, template);
    }

    validateDecision(decision, this.strategyRegistry);
    assertNoContent(decision);
    await this.repo.decisions.create(decision);
    this.events.emit(FabricEventType.DECISION_CREATED, { requestId: req.requestId, decisionId: decision.decisionId, strategy: decision.strategyType, at: this.clock() });
    this.events.emit(FabricEventType.STRATEGY_SELECTED, { requestId: req.requestId, strategy: decision.strategyType, route: decision.primaryRoute, confidence: decision.confidence, at: this.clock() });
    await this._audit(req.requestId, FabricEventType.DECISION_CREATED, { strategyType: decision.strategyType, route: decision.primaryRoute, detail: { confidence: decision.confidence, policyRefs: decision.policyRefs } });

    return { context, decision, policyResult };
  }

  /** Append a control-plane audit entry (best-effort — never fails the request). */
  async _audit(requestId, event, extra = {}) {
    try {
      await this.repo.audit.append({ requestId, event, at: new Date(this.clock()).toISOString(), ...extra });
    } catch {
      // audit is best-effort; the request proceeds
    }
  }

  _tallyExecution(status) {
    if (status === ExecutionStatus.COMPLETED) this._metrics.completed++;
    else if (status === ExecutionStatus.PARTIAL) this._metrics.partial++;
    else if (status === ExecutionStatus.FAILED) this._metrics.failed++;
    else if (status === ExecutionStatus.ABORTED) this._metrics.aborted++;
  }
}

function reqSeq() {
  REQ_SEQ = (REQ_SEQ + 1) % Number.MAX_SAFE_INTEGER;
  return REQ_SEQ;
}

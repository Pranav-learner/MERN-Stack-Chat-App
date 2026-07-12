/**
 * @module optimization/manager/globalOptimizer
 *
 * The **Global Optimizer** (STEP 12) — the reusable orchestrator that optimizes a communication GLOBALLY.
 * For each request it runs the optimization pipeline the sprint specifies:
 *
 *   collect RESOURCES → evaluate QoS (+ adaptive resource policies) → SCHEDULE (mode + lane) →
 *   ALLOCATE resources → COORDINATE devices → BALANCE workload → build the OPTIMIZED EXECUTION PLAN
 *   (execution + scheduling + QoS + resource + coordination + timeline) → persist + emit events.
 *
 * It REUSES the frozen Sprint-1 context builder + execution-plan shape and adds only the global
 * optimization on top — no lower layer is modified. It decides WHEN + WITH WHAT RESOURCES + ON WHICH
 * DEVICE a communication runs; the actual send stays in the frozen Fabric orchestrator (which the
 * optimizer gates via the `executionHook` integration).
 *
 * @performance Pure + synchronous decision path; bounded queue ops; O(policies + lanes + steps). Safe
 * under many concurrent communications (the shared state is the bounded resource budget + lane queues).
 *
 * @security Reasons over communication CONTROL-PLANE metadata + ABSTRACT resource UNITS only — never
 * content/keys, never real OS resources. Every persisted record passes a no-content deep scan.
 *
 * @example
 * ```js
 * const optimizer = new GlobalOptimizer({ ...createInMemoryOptimizationRepository() });
 * const r = await optimizer.optimize({ type: "synchronization", senderId: "alice", conversationId: "c1" }, { callerId: "alice" });
 * // r.qos.qosClass === "background"; r.scheduling.status === "deferred"; r.optimizedPlan.timeline …
 * ```
 */

import { ContextBuilder, validateRequest, normalizeCommunicationRequest, MediaType, ConversationType, RouteKind, StrategyType, SubsystemKind } from "../_fabric.js";
import { GlobalResourceManager } from "../resources/resourceManager.js";
import { estimateCost } from "../resources/costEstimator.js";
import { QoSManager } from "../qos/qosManager.js";
import { CommunicationScheduler } from "../scheduler/scheduler.js";
import { WorkloadBalancer } from "../balancing/workloadBalancer.js";
import { CrossDeviceCoordinator } from "../coordination/deviceCoordinator.js";
import { OptimizedExecutionPlanner } from "../planners/executionPlanner.js";
import { ExecutionCoordinator } from "../execution/executionCoordinator.js";
import { OptimizationEventBus } from "../events/events.js";
import { normalizeOptimizationInput } from "../dto/dto.js";
import { validateRepository, validateConfig, validateScheduling, validateOptimizedPlan, assertAuthorized, assertNoContent } from "../validators/validators.js";
import { toOptimizationView, toResourceView, toQoSView } from "../serializers/serializers.js";
import { OptimizationPolicyConflictError } from "../errors.js";
import { OptimizationEventType, OPTIMIZATION_FRAMEWORK, OPTIMIZATION_SCHEMA_VERSION, OPTIMIZATION_LAYER, OPTIMIZATION_SPRINT, ScheduleStatus } from "../types/types.js";

let SEQ = 0;
const seq = () => (SEQ = (SEQ + 1) % Number.MAX_SAFE_INTEGER);

export class GlobalOptimizer {
  /**
   * @param {object} deps repository bundle (`resources`, `optimizations`, `audit`) + optional overrides
   * @param {OptimizationEventBus} [deps.events] @param {object} [deps.config] `{ budgets, weights, laneCapacity, policyConfig }`
   * @param {object[]} [deps.resourcePolicies] @param {object[]} [deps.schedulingPolicies]
   * @param {object} [deps.providers] `{ device }` @param {object} [deps.resolvers] Sprint-1 context resolvers
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    validateRepository(deps);
    this.repo = { resources: deps.resources, optimizations: deps.optimizations, audit: deps.audit };
    this.config = validateConfig(deps.config ?? {});
    this.events = deps.events ?? new OptimizationEventBus();
    this.clock = deps.clock ?? (() => Date.now());

    this.contextBuilder = new ContextBuilder({ clock: this.clock, resolveAvailability: deps.resolvers?.availability, resolveSync: deps.resolvers?.sync, resolveSecurity: deps.resolvers?.security });
    this.resourceManager = new GlobalResourceManager({ budgets: this.config.budgets, events: this.events, clock: this.clock });
    this.qosManager = new QoSManager({ policies: deps.resourcePolicies, weights: this.config.weights, config: this.config.policyConfig, events: this.events });
    this.scheduler = new CommunicationScheduler({ policies: deps.schedulingPolicies, laneCapacity: this.config.laneCapacity, weights: this.config.weights, events: this.events, clock: this.clock });
    this.workloadBalancer = new WorkloadBalancer({ events: this.events });
    this.deviceCoordinator = new CrossDeviceCoordinator({ deviceProvider: deps.providers?.device, events: this.events });
    this.planner = new OptimizedExecutionPlanner({ clock: this.clock });
    this.executionCoordinator = new ExecutionCoordinator({ scheduler: this.scheduler, resourceManager: this.resourceManager, events: this.events, clock: this.clock });

    this._metrics = { optimized: 0, immediate: 0, deferred: 0, rejected: 0, denied: 0 };
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === the optimization pipeline =============================================

  /**
   * Optimize a communication globally.
   * @param {object} input a communication request + optimization hints (qosClass/mode/window/devices/cost/policyOverrides)
   * @param {object} [opts] `{ callerId, allowServer, dryRun, context, executionPlan }`
   * @returns {Promise<object>} the optimization view
   */
  async optimize(input, opts = {}) {
    this._metrics.optimized++;
    const { request, qosClass, mode, window, devices, costOverride, policyOverrides } = normalizeOptimizationInput(input);
    validateRequest(request);
    if (!opts.allowServer || opts.callerId != null) assertAuthorized(request, opts.callerId, { allowServer: opts.allowServer });
    if (!request.requestId) request.requestId = `oreq_${seq()}`;

    const context = opts.context ?? this.contextBuilder.build(request);
    const analysis = projectAnalysis(context);

    // 1) collect resources (global snapshot)
    const resources = this.resourceManager.snapshot();

    // 2) estimate cost
    const cost = estimateCost(context, costOverride);

    // 3) evaluate QoS (+ adaptive resource policies)
    const qos = this.qosManager.evaluate({ context, analysis, resources }, { qosClass, mode, policyOverrides });
    if (qos.denied) {
      this._metrics.denied++;
      throw new OptimizationPolicyConflictError(`Optimization denied by policy "${qos.denied.policyId}": ${qos.denied.note}`, { details: qos.denied });
    }

    // 4) schedule
    const scheduling = this.scheduler.schedule({ requestId: request.requestId, qos, analysis, resources, window, cost, request });
    validateScheduling(scheduling);
    this.executionCoordinator.register(request.requestId, { status: scheduling.status, cost });
    this._tallySchedule(scheduling.status);

    // 5) allocate resources (immediately for an immediate schedule; queued items reserve at dispatch)
    let allocation = null;
    if (scheduling.proceed) allocation = this.resourceManager.allocate(request.requestId, cost);

    // 6) coordinate devices
    const coordination = this.deviceCoordinator.coordinate({ userId: request.senderId, devices, analysis, requestId: request.requestId });

    // 7) balance workload
    const balance = this.workloadBalancer.balance(this.scheduler.state(), resources);

    // 8) build the optimized execution plan
    const executionPlan = opts.executionPlan ?? synthesizePlan(context, request.requestId);
    const fallbackPlan = executionPlan.routing ? { primaryRoute: executionPlan.routing.primary, candidates: executionPlan.routing.candidates ?? [] } : null;
    const optimizedPlan = this.planner.build({ requestId: request.requestId, executionPlan, qos, scheduling, allocation, coordination, fallbackPlan, cost });
    validateOptimizedPlan(optimizedPlan);

    const result = { requestId: request.requestId, senderId: request.senderId, qos, resources, scheduling, allocation, coordination, balance, optimizedPlan, cost, status: scheduling.status, proceed: scheduling.proceed };

    if (!opts.dryRun) await this._persist(result);
    this.events.emit(OptimizationEventType.OPTIMIZATION_COMPLETED, { requestId: request.requestId, status: scheduling.status, qosClass: qos.qosClass });
    return toOptimizationView(result);
  }

  /** Alias — the "Schedule Communication" API entry point. */
  schedule(input, opts = {}) {
    return this.optimize(input, opts);
  }

  /** The optimized execution plan only (dry run). */
  async getExecutionPlan(input, opts = {}) {
    return (await this.optimize(input, { ...opts, dryRun: true })).optimizedPlan;
  }

  /** The QoS profile for a communication (no scheduling side effects — dry run). */
  async getQoSProfile(input, opts = {}) {
    const { request, qosClass, mode, policyOverrides } = normalizeOptimizationInput(input);
    validateRequest(request);
    if (!opts.allowServer || opts.callerId != null) assertAuthorized(request, opts.callerId, { allowServer: opts.allowServer });
    const context = this.contextBuilder.build(request);
    const analysis = projectAnalysis(context);
    const resources = this.resourceManager.snapshot();
    return toQoSView(this.qosManager.evaluate({ context, analysis, resources }, { qosClass, mode, policyOverrides }));
  }

  /** The resource allocation recommendation for a communication (no reservation — dry run). */
  async getResourceAllocation(input, opts = {}) {
    const { request, costOverride } = normalizeOptimizationInput(input);
    validateRequest(request);
    if (!opts.allowServer || opts.callerId != null) assertAuthorized(request, opts.callerId, { allowServer: opts.allowServer });
    const context = this.contextBuilder.build(request);
    const cost = estimateCost(context, costOverride);
    return { cost, recommendation: this.resourceManager.recommend(cost), snapshot: toResourceView(this.resourceManager.snapshot()) };
  }

  /** The current scheduler + workload-balancer state. */
  getSchedulerState() {
    const state = this.scheduler.state();
    const balance = this.workloadBalancer.balance(state, this.resourceManager.snapshot());
    return { scheduler: state, balance, execution: this.executionCoordinator.snapshot() };
  }

  /**
   * Adaptive dispatch — drain ready queued work, reserve resources, mark RUNNING. Returns the dispatched
   * request ids (the caller re-executes them through the Fabric with `skipOptimization`). This is the
   * scheduling framework's drain step; Sprint 4 wires a worker/loop around it.
   */
  dispatch({ maxConcurrent } = {}) {
    const dispatched = this.executionCoordinator.dispatchReady({ maxConcurrent });
    return { dispatched: dispatched.map((e) => ({ requestId: e.requestId, lane: e.lane, mode: e.mode })), count: dispatched.length };
  }

  /** Mark a dispatched execution completed (release resources). */
  complete(requestId) {
    this.executionCoordinator.complete(requestId);
    return { requestId, released: true };
  }

  /** Mark a dispatched execution failed (release resources). */
  fail(requestId, reason) {
    this.executionCoordinator.fail(requestId, reason);
    return { requestId, released: true };
  }

  /** Diagnostics for a request: its stored optimization record + audit trail. */
  async diagnostics(requestId) {
    const [record, audit] = await Promise.all([this.repo.optimizations.findByRequest(requestId), this.repo.audit.listByRequest(requestId)]);
    return { requestId, optimization: record ? toOptimizationView(reviveRecord(record)) : null, audit };
  }

  /** Aggregate optimization status / health. */
  async status() {
    return {
      framework: OPTIMIZATION_FRAMEWORK,
      layer: OPTIMIZATION_LAYER,
      sprint: OPTIMIZATION_SPRINT,
      schemaVersion: OPTIMIZATION_SCHEMA_VERSION,
      status: "ok",
      resources: toResourceView(this.resourceManager.snapshot()),
      scheduler: this.scheduler.state(),
      execution: this.executionCoordinator.snapshot(),
      metrics: { ...this._metrics },
      at: new Date(this.clock()).toISOString(),
    };
  }

  // === internals =============================================================

  async _persist(result) {
    assertNoContent({ qos: result.qos, scheduling: result.scheduling, coordination: result.coordination, optimizedPlan: result.optimizedPlan, cost: result.cost });
    await this.repo.resources.recordSnapshot(result.resources);
    await this.repo.optimizations.create({
      requestId: result.requestId,
      senderId: result.senderId,
      qos: result.qos,
      scheduling: result.scheduling,
      allocation: result.allocation,
      coordination: result.coordination,
      balance: result.balance,
      optimizedPlan: result.optimizedPlan,
      cost: result.cost,
      status: result.status,
      proceed: result.proceed,
      schemaVersion: OPTIMIZATION_SCHEMA_VERSION,
      createdAt: new Date(this.clock()).toISOString(),
    });
    await this._audit(result.requestId, OptimizationEventType.OPTIMIZATION_COMPLETED, { qosClass: result.qos.qosClass, mode: result.scheduling.mode, status: result.status });
  }

  async _audit(requestId, event, detail = {}) {
    try {
      await this.repo.audit.append({ requestId, event, at: new Date(this.clock()).toISOString(), ...detail });
    } catch {
      /* best-effort */
    }
  }

  _tallySchedule(status) {
    if (status === ScheduleStatus.IMMEDIATE) this._metrics.immediate++;
    else if (status === ScheduleStatus.REJECTED) this._metrics.rejected++;
    else this._metrics.deferred++;
  }
}

/** Project a Sprint-1 context into the small analysis the QoS + scheduling policies read. */
export function projectAnalysis(context) {
  const raw = context.raw ?? context;
  const size = raw.media?.payloadRef?.size ?? raw.media?.size ?? 0;
  return {
    communicationType: raw.type,
    conversationType: raw.conversation?.type,
    priority: raw.transport?.priority,
    mediaType: raw.media?.type,
    isMedia: raw.media?.type != null && raw.media.type !== MediaType.NONE,
    isLarge: size > 4 * 1024 * 1024,
    isSelf: raw.conversation?.type === ConversationType.SELF,
    groupSize: raw.group?.memberHint ?? raw.recipient?.count ?? 0,
  };
}

/** Synthesize a minimal Sprint-1-shaped execution plan for the standalone (no-Fabric-plan) path. */
function synthesizePlan(context, requestId) {
  const a = projectAnalysis(context);
  let strategyType = StrategyType.DIRECT;
  let subsystem = SubsystemKind.MESSAGING;
  let action = "deliver";
  let route = RouteKind.DIRECT_TRANSPORT;
  if (a.isMedia) {
    strategyType = StrategyType.MEDIA;
    subsystem = SubsystemKind.MEDIA;
    action = "deliver-media";
    route = RouteKind.MEDIA_PIPELINE;
  } else if (a.conversationType === ConversationType.GROUP) {
    strategyType = StrategyType.GROUP;
    subsystem = SubsystemKind.GROUP;
    action = "fanout";
    route = RouteKind.GROUP_FANOUT;
  } else if (a.communicationType === "synchronization" || a.isSelf) {
    strategyType = StrategyType.SYNCHRONIZATION;
    subsystem = SubsystemKind.SYNCHRONIZATION;
    action = "sync";
    route = RouteKind.SYNC_CHANNEL;
  }
  const stepId = `synthstep_${seq()}`;
  return {
    planId: `synthplan_${seq()}`,
    requestId,
    strategyType,
    steps: [{ stepId, subsystem, action, route, required: true, dependsOn: [], params: {} }],
    requiredStepIds: [stepId],
    routing: { primary: route, candidates: [] },
    fallbacks: {},
    synthetic: true,
  };
}

/** Revive a persisted optimization record into the shape `toOptimizationView` expects. */
function reviveRecord(record) {
  return {
    requestId: record.requestId,
    qos: record.qos,
    resources: record.resources ?? null,
    scheduling: record.scheduling,
    allocation: record.allocation,
    coordination: record.coordination,
    balance: record.balance,
    optimizedPlan: record.optimizedPlan,
    cost: record.cost,
    status: record.status,
    proceed: record.proceed,
  };
}

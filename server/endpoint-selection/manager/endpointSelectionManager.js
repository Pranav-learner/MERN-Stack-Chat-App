/**
 * @module endpoint-selection/manager
 *
 * The **Endpoint Selection Manager** — the reusable facade for Sprint 5. It turns a set of candidate
 * devices (e.g. the reachable, capability-compatible devices a PDP run resolved) into an OPTIMIZED,
 * failover-ready {@link module:endpoint-selection/planner EndpointConnectionPlan}. Its
 * responsibilities (the sprint spec):
 *
 * - **Evaluate + score + rank** candidate devices (deterministic, extensible scoring).
 * - **Select the primary endpoint** and **generate fallback endpoints**.
 * - **Update routing decisions** (reroute / refresh) and support **failover**.
 * - **Cache** results, **validate** plans, and record **historical reliability**.
 *
 * @important This subsystem selects endpoints + prepares plans. It does NOT establish connections,
 * do NAT traversal, or run ICE/STUN/TURN/WebRTC. A FUTURE Layer 7 consumes the plan.
 *
 * @security Plans, rankings, DTOs, and events carry PUBLIC data only — device ids, public
 * identities, presence status, negotiated versions/transports/flags, scores — never private keys,
 * session keys, message keys, chain keys, or shared secrets.
 *
 * @example
 * ```js
 * const mgr = new EndpointSelectionManager({ ...createInMemoryEndpointRepository() });
 * const { plan } = await mgr.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates });
 * plan.primaryEndpoint.deviceId; plan.fallbackEndpoints; plan.retryStrategy; // Layer 7 consumes this
 * ```
 */

import crypto from "node:crypto";
import {
  EndpointEventType,
  EndpointFailureReason,
  EndpointSource,
  OutcomeType,
  SelectionPolicy,
  DEFAULT_MAX_FALLBACKS,
} from "../types/types.js";
import { EndpointError, SelectionFailedError, NoFallbackError } from "../errors.js";
import { rankEndpoints, isReachable } from "../scorer/scoring.js";
import { resolvePolicy } from "../policies/policies.js";
import { createEndpointConnectionPlan, planCacheKey, isPlanExpired } from "../planner/connectionPlan.js";
import { rerouteFirst } from "../routing/routing.js";
import { applyFailover, markExhausted, refreshRouting } from "../failover/failover.js";
import { EndpointCache } from "../cache/cache.js";
import { EndpointEventBus } from "../events/events.js";
import {
  validateGenerateRequest,
  validateCandidates,
  validatePlanId,
  validateUserRef,
  validateDeviceRef,
  requirePlan,
  assertRequester,
  assertPlanNotExpired,
  assertNoSecretMaterial,
  validatePlanRepository,
  validateReliabilityRepository,
} from "../validators/validators.js";
import {
  toPublicPlan,
  toPublicEndpoint,
  toPublicRanked,
  toPlanStatus,
} from "../serializers/serializer.js";

export class EndpointSelectionManager {
  /**
   * @param {object} deps
   * @param {object} deps.plans plan repository (required) @param {object} deps.reliability reliability repository (required)
   * @param {object} [deps.selections] selection-history repository (optional; enables history)
   * @param {EndpointCache} [deps.cache] @param {EndpointEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {string|object} [deps.defaultPolicy] @param {number} [deps.maxFallbacks] @param {number} [deps.planTtlMs]
   * @param {object} [deps.securityRequirements] default `{ minCryptoVersion }`
   */
  constructor(deps) {
    if (!deps || !deps.plans || !deps.reliability) throw new Error("EndpointSelectionManager requires { plans, reliability }");
    this.plans = validatePlanRepository(deps.plans);
    this.reliability = validateReliabilityRepository(deps.reliability);
    this.selections = deps.selections ?? null;
    this.events = deps.events ?? new EndpointEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.defaultPolicy = deps.defaultPolicy;
    this.maxFallbacks = deps.maxFallbacks ?? DEFAULT_MAX_FALLBACKS;
    this.planTtlMs = deps.planTtlMs;
    this.securityRequirements = deps.securityRequirements;
    this.cache = deps.cache ?? new EndpointCache({ clock: this.clock });
  }

  // === ranking (no persistence) ===========================================

  /**
   * Score + rank a set of candidate devices under a policy — WITHOUT producing a plan. Emits
   * `ENDPOINT_RANKED` + `SELECTION_POLICY_APPLIED`.
   * @param {{ requester?: string, targetUser: string, candidates: object[], policy?: string|object, preferredPlatform?: string, preferredDeviceId?: string, securityRequirements?: object }} request
   * @returns {Promise<{ ranking: object[], policy: string }>}
   */
  async rankDevices(request) {
    validateUserRef(request.targetUser);
    validateCandidates(request.candidates);
    const policy = resolvePolicy(request.policy ?? this.defaultPolicy, { weights: request.weights, preferType: request.preferType });
    const ranked = await this._rank(request, policy);
    this.events.emit(EndpointEventType.SELECTION_POLICY_APPLIED, { targetUser: request.targetUser, policy: policy.name });
    this.events.emit(EndpointEventType.ENDPOINT_RANKED, { targetUser: request.targetUser, policy: policy.name, count: ranked.length });
    return { ranking: ranked.map(toPublicRanked), policy: policy.name };
  }

  // === plan generation ====================================================

  /**
   * Generate an optimized connection plan: score + rank the candidates, select a primary + fallbacks,
   * and assemble the plan. Emits `PRIMARY_ENDPOINT_SELECTED`, `FALLBACK_GENERATED`,
   * `CONNECTION_PLAN_CREATED`. @throws {SelectionFailedError} when no candidate is usable.
   *
   * @param {{ requester: string, requesterDevice: string, targetUser: string, candidates: object[],
   *   policy?: string|object, weights?: object, preferType?: string, preferredPlatform?: string,
   *   preferredDeviceId?: string, securityRequirements?: object, maxFallbacks?: number, retry?: object,
   *   ttlMs?: number, metadata?: object }} request
   * @param {{ useCache?: boolean }} [options]
   * @returns {Promise<{ plan: object, ranking: object[], source: string }>}
   */
  async generateConnectionPlan(request, options = {}) {
    validateGenerateRequest(request);
    const policy = resolvePolicy(request.policy ?? this.defaultPolicy, { weights: request.weights, preferType: request.preferType });
    const candidateIds = request.candidates.map((c) => c.deviceId);
    const cacheKey = planCacheKey({ requester: request.requester, requesterDevice: request.requesterDevice, targetUser: request.targetUser, policyName: policy.name, candidateIds });

    if (options.useCache !== false) {
      const probe = this.cache.get(cacheKey);
      if (probe.outcome === "hit" && !isPlanExpired(probe.value, this.clock())) {
        return { plan: probe.value, ranking: [], source: EndpointSource.CACHE };
      }
    }

    const ranked = await this._rank(request, policy);
    this.events.emit(EndpointEventType.SELECTION_POLICY_APPLIED, { targetUser: request.targetUser, policy: policy.name });
    this.events.emit(EndpointEventType.ENDPOINT_RANKED, { targetUser: request.targetUser, policy: policy.name, count: ranked.length });

    const eligible = ranked.filter((r) => r.eligible);
    if (eligible.length === 0) {
      const reason = this._noEligibleReason(ranked);
      this.events.emit(EndpointEventType.SELECTION_FAILED, { requester: request.requester, targetUser: request.targetUser, reason });
      throw new SelectionFailedError(`No usable endpoint for user "${request.targetUser}"`, { reason, details: { candidateCount: ranked.length } });
    }

    const plan = createEndpointConnectionPlan({
      requester: request.requester,
      requesterDevice: request.requesterDevice,
      targetUser: request.targetUser,
      ranked,
      policyName: policy.name,
      weights: policy.weights,
      maxFallbacks: request.maxFallbacks ?? this.maxFallbacks,
      retry: request.retry,
      ttlMs: request.ttlMs ?? this.planTtlMs,
      metadata: request.metadata,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    assertNoSecretMaterial(plan, "connection plan");
    const stored = await this.plans.create(plan);
    const dto = toPublicPlan(stored);
    await this._recordSelection(stored, "generate", ranked);
    this.cache.set(cacheKey, dto, { requester: stored.requester, targetUser: stored.targetUser });

    this.events.emit(EndpointEventType.PRIMARY_ENDPOINT_SELECTED, { planId: stored.planId, requester: stored.requester, targetUser: stored.targetUser, primaryDeviceId: stored.primaryEndpoint.deviceId });
    if (stored.fallbackEndpoints.length > 0) {
      this.events.emit(EndpointEventType.FALLBACK_GENERATED, { planId: stored.planId, targetUser: stored.targetUser, count: stored.fallbackEndpoints.length, priorityOrder: stored.priorityOrder });
    }
    this.events.emit(EndpointEventType.CONNECTION_PLAN_CREATED, { planId: stored.planId, requester: stored.requester, targetUser: stored.targetUser, primaryDeviceId: stored.primaryEndpoint.deviceId, preferredTransport: stored.preferredTransport });
    return { plan: dto, ranking: ranked.map(toPublicRanked), source: EndpointSource.COMPUTED };
  }

  /** Generate a plan + return just the selected primary endpoint. @returns {Promise<object|null>} */
  async selectEndpoint(request, options = {}) {
    const { plan } = await this.generateConnectionPlan(request, options);
    return plan.primaryEndpoint ?? null;
  }

  // === routing updates + failover =========================================

  /**
   * Fail over: promote the next fallback to primary. Records the failed primary as a FAILURE
   * (reliability feedback). Emits `ROUTING_UPDATED`, `FALLBACK_GENERATED`, `CONNECTION_PLAN_UPDATED`.
   * @throws {NoFallbackError} when there is no fallback (the plan is marked EXHAUSTED first).
   * @param {string} planId @param {{ actingUser?: string, reason?: string }} [options]
   * @returns {Promise<object>} the updated plan DTO
   */
  async failover(planId, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    try {
      const { plan: newPlan, failedDevice, promotedDevice } = applyFailover(plan, { reason: options.reason, now: this.clock() });
      if (failedDevice) await this.reliability.record(plan.targetUser, failedDevice, OutcomeType.FAILURE);
      const stored = await this.plans.update(planId, newPlan);
      await this._recordSelection(stored, "failover", null);
      this._invalidate(stored);
      this.events.emit(EndpointEventType.OUTCOME_RECORDED, { planId, targetUser: plan.targetUser, deviceId: failedDevice, outcome: OutcomeType.FAILURE });
      this.events.emit(EndpointEventType.ROUTING_UPDATED, { planId, targetUser: plan.targetUser, primaryDeviceId: promotedDevice, priorityOrder: stored.priorityOrder });
      this.events.emit(EndpointEventType.FALLBACK_GENERATED, { planId, targetUser: plan.targetUser, count: stored.fallbackEndpoints.length });
      this.events.emit(EndpointEventType.CONNECTION_PLAN_UPDATED, { planId, targetUser: plan.targetUser, primaryDeviceId: promotedDevice, generation: stored.generation });
      return toPublicPlan(stored);
    } catch (error) {
      if (error instanceof NoFallbackError) {
        if (plan.primaryEndpoint) await this.reliability.record(plan.targetUser, plan.primaryEndpoint.deviceId, OutcomeType.FAILURE);
        const exhausted = await this.plans.update(planId, markExhausted(plan, { now: this.clock() }));
        this._invalidate(exhausted);
        this.events.emit(EndpointEventType.SELECTION_FAILED, { planId, targetUser: plan.targetUser, reason: EndpointFailureReason.MISSING_FALLBACK });
      }
      throw error;
    }
  }

  /**
   * Record the outcome of using an endpoint (success/failure) → updates historical reliability.
   * Emits `OUTCOME_RECORDED`. @param {string} planId @param {string} deviceId @param {string} outcome
   * @param {{ actingUser?: string }} [options] @returns {Promise<object>} the reliability record
   */
  async recordOutcome(planId, deviceId, outcome, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    validateDeviceRef(deviceId);
    const normalized = outcome === OutcomeType.FAILURE ? OutcomeType.FAILURE : OutcomeType.SUCCESS;
    const record = await this.reliability.record(plan.targetUser, deviceId, normalized);
    this._invalidate(plan); // reliability changed → future scores differ
    this.events.emit(EndpointEventType.OUTCOME_RECORDED, { planId, targetUser: plan.targetUser, deviceId, outcome: normalized });
    return record;
  }

  /**
   * Refresh a plan's routing from fresh candidate data (e.g. a device recovered / presence changed).
   * Keeps the planId, bumps the generation. Emits `ROUTING_UPDATED` + `CONNECTION_PLAN_UPDATED`.
   * @param {string} planId @param {{ candidates: object[], actingUser?: string }} options
   * @returns {Promise<object>} the updated plan DTO
   */
  async refreshPlan(planId, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    validateCandidates(options.candidates);
    const policy = resolvePolicy(plan.selectionPolicy, { weights: plan.weights });
    const ranked = await this._rank({ targetUser: plan.targetUser, candidates: options.candidates }, policy);
    const refreshed = refreshRouting(plan, ranked, { maxFallbacks: this.maxFallbacks, now: this.clock() });
    if (!refreshed.primaryEndpoint) {
      const reason = this._noEligibleReason(ranked);
      this.events.emit(EndpointEventType.SELECTION_FAILED, { planId, targetUser: plan.targetUser, reason });
      throw new SelectionFailedError(`Refresh found no usable endpoint for "${plan.targetUser}"`, { reason });
    }
    assertNoSecretMaterial(refreshed, "connection plan");
    const stored = await this.plans.update(planId, refreshed);
    await this._recordSelection(stored, "refresh", ranked);
    this._invalidate(stored);
    this.events.emit(EndpointEventType.ROUTING_UPDATED, { planId, targetUser: plan.targetUser, primaryDeviceId: stored.primaryEndpoint.deviceId, priorityOrder: stored.priorityOrder });
    this.events.emit(EndpointEventType.CONNECTION_PLAN_UPDATED, { planId, targetUser: plan.targetUser, primaryDeviceId: stored.primaryEndpoint.deviceId, generation: stored.generation });
    return toPublicPlan(stored);
  }

  /**
   * Update routing to try a specific device first (alternative routing) without recomputing scores.
   * Emits `ROUTING_UPDATED`. @param {string} planId @param {string} deviceId @param {{ actingUser?: string }} [options]
   * @returns {Promise<object>} the updated plan DTO
   */
  async updateRouting(planId, deviceId, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    assertPlanNotExpired(plan, this.clock());
    validateDeviceRef(deviceId);
    const routing = { primary: plan.primaryEndpoint, fallbacks: plan.fallbackEndpoints, priorityOrder: plan.priorityOrder, retryStrategy: plan.retryStrategy };
    const rerouted = rerouteFirst(routing, deviceId);
    const patch = {
      primaryEndpoint: rerouted.primary,
      fallbackEndpoints: rerouted.fallbacks,
      priorityOrder: rerouted.priorityOrder,
      negotiatedCapabilities: rerouted.primary?.capabilities ?? null,
      preferredTransport: rerouted.primary?.capabilities?.preferredTransport ?? null,
      fallbackTransports: rerouted.primary?.capabilities?.fallbackChain ?? [],
      retryStrategy: rerouted.retryStrategy,
      priority: rerouted.primary?.priority ?? 0,
      generation: (plan.generation ?? 0) + 1,
      updatedAt: this._nowIso(),
    };
    const stored = await this.plans.update(planId, patch);
    await this._recordSelection(stored, "reroute", null);
    this._invalidate(stored);
    this.events.emit(EndpointEventType.ROUTING_UPDATED, { planId, targetUser: plan.targetUser, primaryDeviceId: stored.primaryEndpoint?.deviceId, priorityOrder: stored.priorityOrder });
    this.events.emit(EndpointEventType.CONNECTION_PLAN_UPDATED, { planId, targetUser: plan.targetUser, generation: stored.generation });
    return toPublicPlan(stored);
  }

  // === queries ============================================================

  /** A connection plan by id (public DTO + expired flag). Requester-scoped optionally. */
  async getConnectionPlan(planId, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    return { plan: toPublicPlan(plan), expired: isPlanExpired(plan, this.clock()) };
  }

  /** Compact plan status (for polling). */
  async getPlanStatus(planId, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    return toPlanStatus(plan);
  }

  /** The fallback endpoints of a plan (public DTOs). */
  async getFallbacks(planId, options = {}) {
    const plan = await this._require(planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    return (plan.fallbackEndpoints ?? []).map(toPublicEndpoint);
  }

  /** A requester's connection plans (routing history). */
  async listPlans(requester, options = {}) {
    validateUserRef(requester);
    const list = await this.plans.listByRequester(String(requester), { limit: options.limit });
    return list.map(toPublicPlan);
  }

  /** Selection/routing history (from the selections store). */
  async listSelections(requester, options = {}) {
    validateUserRef(requester);
    if (!this.selections) return [];
    const list = options.targetUser
      ? await this.selections.listByTarget(String(requester), String(options.targetUser), { limit: options.limit })
      : await this.selections.listByRequester(String(requester), { limit: options.limit });
    return list;
  }

  /** Endpoint-cache statistics. */
  cacheStats() {
    return this.cache.stats();
  }

  // === internals ==========================================================

  /** @private Score + rank a request's candidates under a resolved policy. */
  async _rank(request, policy) {
    const candidateIds = request.candidates.map((c) => c.deviceId);
    const reliability = await this.reliability.getMany(request.targetUser, candidateIds);
    const preferredDeviceId = request.preferredDeviceId ?? (policy.name === SelectionPolicy.MANUAL_PREFERENCE ? request.preferDeviceId : undefined);
    const ctx = {
      now: this.clock(),
      reliability,
      preferredPlatform: request.preferredPlatform,
      preferredDeviceId,
      preferType: policy.preferType,
      securityRequirements: request.securityRequirements ?? this.securityRequirements,
    };
    return rankEndpoints(request.candidates, ctx, policy.weights, policy.extraDimensions);
  }

  /** @private Determine why no candidate was eligible (reachability vs compatibility). */
  _noEligibleReason(ranked) {
    const anyReachable = (ranked ?? []).some((r) => isReachable(r.candidate));
    return anyReachable ? EndpointFailureReason.NO_COMPATIBLE_ENDPOINT : EndpointFailureReason.NO_REACHABLE_ENDPOINT;
  }

  /** @private Load + require a plan by id (validated). */
  async _require(planId) {
    validatePlanId(planId);
    return requirePlan(await this.plans.findById(planId), planId);
  }

  /** @private Append a selection/routing history record. */
  async _recordSelection(plan, action, ranked) {
    if (!this.selections) return null;
    const selection = {
      selectionId: this.idGenerator(),
      planId: plan.planId,
      requester: plan.requester,
      targetUser: plan.targetUser,
      action,
      selectionPolicy: plan.selectionPolicy,
      weights: plan.weights,
      primaryDeviceId: plan.primaryEndpoint?.deviceId ?? null,
      priorityOrder: plan.priorityOrder ?? [],
      ranking: ranked ? ranked.map(toPublicRanked) : [],
      reason: plan.selectionReason,
      at: this._nowIso(),
      schemaVersion: plan.schemaVersion,
    };
    return this.selections.record(selection);
  }

  /** @private Invalidate cached plans touching a plan's requester + target. */
  _invalidate(plan) {
    const removed = this.cache.invalidateRequester(plan.requester) + this.cache.invalidateTarget(plan.targetUser);
    if (removed > 0) this.events.emit(EndpointEventType.CACHE_INVALIDATED, { requester: plan.requester, targetUser: plan.targetUser, removed });
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

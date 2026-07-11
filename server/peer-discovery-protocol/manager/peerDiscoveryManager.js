/**
 * @module pdp/manager
 *
 * The **Peer Discovery Manager** — the reusable facade for the Peer Discovery Protocol (Layer 6,
 * Sprint 4). It ORCHESTRATES the three Sprint 1–3 subsystems (Discovery, Presence, Capabilities)
 * through one deterministic {@link module:pdp/workflow workflow} and produces the protocol's sole
 * output: a validated {@link module:pdp/planner ConnectionPlan}. Its responsibilities (the sprint
 * spec):
 *
 * - **Start discovery** — run the unified workflow for a target user.
 * - **Resolve user / devices / presence / capabilities** — the workflow stages, in order.
 * - **Select devices** — deterministic, configurable selection policies.
 * - **Generate a connection plan** — fuse everything into the transport-independent plan.
 * - **Track the discovery session** — lifecycle state, stage, history; support recovery.
 *
 * @important PDP establishes NO connection. It produces a plan only. A FUTURE Layer 7 (NAT
 * Traversal / ICE / STUN / TURN / WebRTC) consumes the plan + these events to actually connect.
 *
 * @security Sessions, plans, DTOs, and events carry PUBLIC data only — ids, public identities,
 * presence status, negotiated versions/transports/flags — never private keys, session keys, message
 * keys, chain keys, or shared secrets.
 *
 * @example
 * ```js
 * const pdp = new PeerDiscoveryManager({ discovery, presence, capabilities, ...createInMemoryPdpRepository() });
 * const { session, plan } = await pdp.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
 * plan.primaryDeviceId; plan.preferredTransport; // Layer 7 consumes this
 * ```
 */

import crypto from "node:crypto";
import {
  PdpState,
  PdpEventType,
  PdpFailureReason,
  PdpSource,
  WorkflowStage,
  DEFAULT_MAX_SELECTED_DEVICES,
  isTerminalPdpState,
} from "../types/types.js";
import { PdpError } from "../errors.js";
import { assertPdpTransition } from "../workflow/lifecycle.js";
import {
  createPdpSession,
  pdpDedupeKey,
  isPdpSessionExpired,
  stageEntry,
  appendAudit,
} from "../workflow/session.js";
import { runDiscoveryWorkflow } from "../workflow/workflow.js";
import { createConnectionPlan, planCacheKey, isPlanExpired } from "../planner/connectionPlan.js";
import { resolveSelectionPolicy } from "../selectors/selection.js";
import { isRecoverableFailure } from "../protocol/protocol.js";
import { ConnectionPlanCache } from "../cache/cache.js";
import { PdpEventBus } from "../events/events.js";
import {
  validateStartRequest,
  validateDiscoveryId,
  validatePlanId,
  validateUserRef,
  requirePdpSession,
  requirePlan,
  assertRequester,
  assertNoSecretMaterial,
  validateSessionRepository,
  validatePlanRepository,
} from "../validators/validators.js";
import {
  toPublicSession,
  toPublicPlan,
  toPdpStatus,
  toSessionListItem,
} from "../serializers/serializer.js";

export class PeerDiscoveryManager {
  /**
   * @param {object} deps
   * @param {object} deps.discovery a DiscoveryManager (Sprint 1)
   * @param {object} deps.presence a PresenceManager (Sprint 2)
   * @param {object} deps.capabilities a CapabilityManager (Sprint 3)
   * @param {object} deps.sessions PDP session repository (required)
   * @param {object} deps.plans connection-plan repository (required)
   * @param {ConnectionPlanCache} [deps.cache]
   * @param {PdpEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {string} [deps.selectionPolicy] default selection policy
   * @param {string|object} [deps.transportPolicy] default capability transport policy
   * @param {number} [deps.planTtlMs] @param {number} [deps.sessionTtlMs] @param {number} [deps.maxDevices]
   */
  constructor(deps) {
    if (!deps || !deps.discovery || !deps.presence || !deps.capabilities) {
      throw new Error("PeerDiscoveryManager requires { discovery, presence, capabilities }");
    }
    if (!deps.sessions || !deps.plans) throw new Error("PeerDiscoveryManager requires { sessions, plans }");
    this.discovery = deps.discovery;
    this.presence = deps.presence;
    this.capabilities = deps.capabilities;
    this.sessions = validateSessionRepository(deps.sessions);
    this.plans = validatePlanRepository(deps.plans);
    this.events = deps.events ?? new PdpEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.selectionPolicy = deps.selectionPolicy;
    this.transportPolicy = deps.transportPolicy;
    this.planTtlMs = deps.planTtlMs;
    this.sessionTtlMs = deps.sessionTtlMs;
    this.maxDevices = deps.maxDevices ?? DEFAULT_MAX_SELECTED_DEVICES;
    this.cache = deps.cache ?? new ConnectionPlanCache({ clock: this.clock });
    /** @private in-flight coalescing: dedupeKey -> Promise */
    this._inflight = new Map();
  }

  // === the protocol entry point ===========================================

  /**
   * Start a discovery run: execute the unified workflow and produce a connection plan. Identical
   * concurrent runs are coalesced; a recent identical plan may be served from cache.
   *
   * @param {{ requester: string, requesterDevice: string, targetUser: string, targetDevices?: string[],
   *   selectionPolicy?: string, transportPolicy?: string|object, selectionOptions?: object, maxDevices?: number,
   *   ttlMs?: number, planTtlMs?: number, metadata?: object }} request
   * @param {{ useCache?: boolean }} [options]
   * @returns {Promise<{ session: object, plan: object|null, source: string }>}
   */
  async startDiscovery(request, options = {}) {
    const normalized = this._normalize(request);
    const key = pdpDedupeKey(normalized);
    if (this._inflight.has(key)) return this._inflight.get(key);
    const promise = this._start(normalized, options).finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }

  /** @private */
  async _start(normalized, options) {
    const useCache = options.useCache !== false;
    const cacheKey = planCacheKey(normalized);

    // Fast path: a recent identical plan is still valid → new session, fast-forwarded to completed.
    if (useCache) {
      const probe = this.cache.get(cacheKey);
      if (probe.outcome === "hit" && !isPlanExpired(probe.value, this.clock())) {
        return this._completeFromCache(normalized, probe.value);
      }
    }

    const session = await this._createSession(normalized);
    this.events.emit(PdpEventType.DISCOVERY_REQUESTED, this._eventFor(session));
    return this._runWorkflow(session, normalized, cacheKey);
  }

  /** @private The full workflow run with staged state transitions + events + plan assembly. */
  async _runWorkflow(sessionRecord, normalized, cacheKey) {
    let session = await this._transition(sessionRecord, PdpState.RESOLVING, { reason: "workflow-start" });
    const emittedStates = { negotiating: false, planning: false };

    const hook = async (stage, status, meta = {}) => {
      // Advance the coarse FSM state at stage boundaries.
      if (stage === WorkflowStage.CAPABILITIES && status === "started" && !emittedStates.negotiating) {
        session = await this._transition(session, PdpState.NEGOTIATING, { reason: "negotiating" });
        emittedStates.negotiating = true;
      }
      if (stage === WorkflowStage.SELECTION && status === "started" && !emittedStates.planning) {
        session = await this._transition(session, PdpState.PLANNING, { reason: "planning" });
        emittedStates.planning = true;
      }
      // Record stage history + emit stage + semantic events.
      session = await this._recordStage(session, stage, status, meta);
      if (status === "started") this.events.emit(PdpEventType.STAGE_STARTED, this._eventFor(session, { stage }));
      if (status === "completed") {
        this.events.emit(PdpEventType.STAGE_COMPLETED, this._eventFor(session, { stage, ...meta }));
        this._emitSemantic(session, stage, meta);
      }
    };

    let resolved;
    try {
      resolved = await runDiscoveryWorkflow(
        { ...normalized, clock: this.clock },
        { discovery: this.discovery, presence: this.presence, capabilities: this.capabilities },
        hook,
      );
    } catch (error) {
      return this._failWorkflow(session, error);
    }

    // ── stage: plan (the only writing stage) ──────────────────────────────────
    session = await this._recordStage(session, WorkflowStage.PLAN, "started");
    const plan = createConnectionPlan({
      discoveryId: session.discoveryId,
      requester: session.requester,
      requesterDevice: session.requesterDevice,
      targetUser: session.targetUser,
      selectedDevices: resolved.selectedDevices,
      presenceSnapshot: resolved.presenceSnapshot,
      selectionPolicy: session.selectionPolicy,
      ttlMs: normalized.planTtlMs ?? this.planTtlMs,
      metadata: { discoveredCount: resolved.discoveredCount, candidateCount: resolved.candidateCount },
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    assertNoSecretMaterial(plan, "connection plan");
    const storedPlan = await this.plans.create(plan);
    this.cache.set(cacheKey, storedPlan);
    session = await this._recordStage(session, WorkflowStage.PLAN, "completed", { planId: storedPlan.planId });
    this.events.emit(PdpEventType.CONNECTION_PLAN_CREATED, this._eventFor(session, { planId: storedPlan.planId, primaryDeviceId: storedPlan.primaryDeviceId, preferredTransport: storedPlan.preferredTransport }));

    session = await this._transition(session, PdpState.COMPLETED, {
      reason: "plan-created",
      patch: { planId: storedPlan.planId, completedAt: this._nowIso() },
      event: PdpEventType.WORKFLOW_COMPLETED,
      eventExtras: { planId: storedPlan.planId },
    });
    return { session: toPublicSession(session), plan: toPublicPlan(storedPlan), source: PdpSource.COMPUTED };
  }

  /** @private A cache hit: create a session + fast-forward it through the FSM to COMPLETED. */
  async _completeFromCache(normalized, cachedPlan) {
    let session = await this._createSession(normalized);
    this.events.emit(PdpEventType.DISCOVERY_REQUESTED, this._eventFor(session));
    for (const state of [PdpState.RESOLVING, PdpState.NEGOTIATING, PdpState.PLANNING]) {
      session = await this._transition(session, state, { reason: "served-from-cache" });
    }
    session = await this._recordStage(session, WorkflowStage.PLAN, "completed", { planId: cachedPlan.planId, cached: true });
    session = await this._transition(session, PdpState.COMPLETED, {
      reason: "served-from-cache",
      patch: { planId: cachedPlan.planId, completedAt: this._nowIso() },
      event: PdpEventType.WORKFLOW_COMPLETED,
      eventExtras: { planId: cachedPlan.planId, source: PdpSource.CACHE },
    });
    return { session: toPublicSession(session), plan: toPublicPlan(cachedPlan), source: PdpSource.CACHE };
  }

  /** @private Move a session to FAILED with the workflow error's stage + reason. */
  async _failWorkflow(session, error) {
    const reason = error?.reason ?? PdpFailureReason.INTERNAL_ERROR;
    const stage = error?.stage ?? session.stage;
    // Hard validation/authorization errors bubble up; workflow-stage failures return a failed session.
    const failed = await this._transition(session, PdpState.FAILED, {
      reason,
      patch: { failureReason: reason, stage },
      event: PdpEventType.WORKFLOW_FAILED,
      eventExtras: { stage, reason },
      audit: { action: "failed", stage, reason, at: this._nowIso() },
    });
    if (error instanceof PdpError && error.code === "ERR_PDP_VALIDATION") throw error;
    return { session: toPublicSession(failed), plan: null, source: PdpSource.COMPUTED };
  }

  // === recovery / cancel ==================================================

  /**
   * Recover (retry) a failed discovery run — only for RECOVERABLE failures. Re-runs the workflow
   * from the start, incrementing the attempt counter. Emits `WORKFLOW_RECOVERED`.
   * @param {string} discoveryId @param {{ actingUser?: string }} [options]
   * @returns {Promise<{ session: object, plan: object|null, source: string }>}
   */
  async recoverDiscovery(discoveryId, options = {}) {
    let session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    if (session.state !== PdpState.FAILED) {
      throw new PdpError(`Only a failed discovery can be recovered (state: ${session.state})`, { code: "ERR_PDP_INVALID_TRANSITION", status: 409 });
    }
    if (!isRecoverableFailure(session.failureReason)) {
      throw new PdpError(`Discovery failure "${session.failureReason}" is not recoverable`, { code: "ERR_PDP_INVALID_TRANSITION", status: 409, details: { failureReason: session.failureReason } });
    }
    session = await this._transition(session, PdpState.RECOVERY, {
      reason: "recover",
      patch: { attempts: (session.attempts ?? 0) + 1, failureReason: null },
      event: PdpEventType.WORKFLOW_RECOVERED,
    });
    const normalized = this._normalize(session);
    return this._runWorkflow(session, normalized, planCacheKey(normalized));
  }

  /** Cancel an active discovery run. Emits `WORKFLOW_CANCELLED`. */
  async cancelDiscovery(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    if (isTerminalPdpState(session.state)) {
      throw new PdpError(`Cannot cancel a discovery in state "${session.state}"`, { code: "ERR_PDP_INVALID_TRANSITION", status: 409 });
    }
    return toPublicSession(
      await this._transition(session, PdpState.CANCELLED, {
        reason: options.reason ?? "cancelled",
        patch: { failureReason: PdpFailureReason.CANCELLED },
        event: PdpEventType.WORKFLOW_CANCELLED,
      }),
    );
  }

  // === lighter resolution helpers =========================================

  /**
   * Resolve which of a target user's devices are discoverable AND reachable — the workflow's
   * resolve stages without negotiation/selection. Does NOT create a session.
   * @param {{ requester: string, requesterDevice?: string, targetUser: string }} request
   * @returns {Promise<{ targetUser: string, devices: object[] }>}
   */
  async resolveDevices(request) {
    validateUserRef(request.requester);
    validateUserRef(request.targetUser);
    const { metadata } = await this.discovery.lookupUser({ requester: request.requester, targetUser: request.targetUser, requesterDevice: request.requesterDevice });
    if (!metadata) return { targetUser: String(request.targetUser), devices: [] };
    const { devices: reachable } = await this.presence.resolveActiveDevices(request.targetUser);
    const reachableIds = new Set((reachable ?? []).map((a) => a.deviceId));
    const devices = (metadata.devices ?? [])
      .filter((d) => reachableIds.has(d.deviceId))
      .map((d) => ({ deviceId: d.deviceId, identityId: d.identityId, platform: d.platform, reachable: true }));
    return { targetUser: String(request.targetUser), devices };
  }

  /**
   * Resolve the single preferred device + transport for a target user (runs the full protocol and
   * returns just the primary from the plan). @returns {Promise<object|null>}
   */
  async resolvePreferredDevice(request, options = {}) {
    const { plan } = await this.startDiscovery(request, options);
    if (!plan || !plan.selectedDevices?.length) return null;
    const primary = plan.selectedDevices[0];
    return {
      planId: plan.planId,
      deviceId: primary.deviceId,
      preferredTransport: plan.preferredTransport,
      fallbackTransports: plan.fallbackTransports,
      protocolVersion: plan.protocolVersion,
      cryptoVersion: plan.cryptoVersion,
      priority: primary.priority,
    };
  }

  // === queries ============================================================

  /** Load a PDP session by id (public DTO). Lazily expires it on read. */
  async getDiscovery(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    const current = (await this._sweepIfExpired(session)) ?? session;
    return toPublicSession(current, { includeAudit: options.includeAudit });
  }

  /** Compact status of a PDP session (for polling). */
  async getDiscoveryStatus(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    const current = (await this._sweepIfExpired(session)) ?? session;
    return toPdpStatus(current);
  }

  /** The connection plan produced by a discovery run. @throws {PdpNotFoundError} */
  async getConnectionPlan(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    const plan = requirePlan(await this.plans.findByDiscoveryId(discoveryId), discoveryId);
    return { plan: toPublicPlan(plan), expired: isPlanExpired(plan, this.clock()) };
  }

  /** A connection plan by its planId. @throws {PdpNotFoundError} */
  async getPlanById(planId, options = {}) {
    validatePlanId(planId);
    const plan = requirePlan(await this.plans.findById(planId), planId);
    if (options.actingUser) assertRequester(plan, options.actingUser);
    return { plan: toPublicPlan(plan), expired: isPlanExpired(plan, this.clock()) };
  }

  /** List a requester's discovery runs (history). */
  async listDiscoveries(requester, options = {}) {
    validateUserRef(requester);
    const list = await this.sessions.listByRequester(String(requester), { activeOnly: options.activeOnly, limit: options.limit });
    return list.map(toSessionListItem);
  }

  /** Sweep expired active sessions to EXPIRED + prune the plan cache. */
  async sweepExpired(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const stale = await this.sessions.listExpired(nowIso);
    let expired = 0;
    for (const session of stale) {
      try {
        await this._transition(session, PdpState.EXPIRED, {
          reason: "ttl-elapsed",
          patch: { failureReason: PdpFailureReason.EXPIRED_SESSION },
          event: PdpEventType.WORKFLOW_EXPIRED,
        });
        expired++;
      } catch {
        // concurrent transition already moved it
      }
    }
    const cachePruned = this.cache.pruneExpired(now);
    return { expired, cachePruned };
  }

  /** Connection-plan cache statistics. */
  cacheStats() {
    return this.cache.stats();
  }

  // === internals ==========================================================

  /** @private Normalize + validate a start request. */
  _normalize(request) {
    validateStartRequest(request);
    return {
      requester: String(request.requester),
      requesterDevice: String(request.requesterDevice),
      targetUser: String(request.targetUser),
      targetDevices: (request.targetDevices ?? []).map(String),
      selectionPolicy: resolveSelectionPolicy(request.selectionPolicy ?? this.selectionPolicy),
      transportPolicy: request.transportPolicy ?? this.transportPolicy,
      selectionOptions: request.selectionOptions ?? {},
      maxDevices: request.maxDevices ?? this.maxDevices,
      ttlMs: request.ttlMs ?? this.sessionTtlMs,
      planTtlMs: request.planTtlMs,
      metadata: request.metadata,
    };
  }

  /** @private Persist a fresh CREATED session. */
  async _createSession(normalized) {
    const session = createPdpSession({ ...normalized, clock: this.clock, idGenerator: this.idGenerator });
    session.audit = appendAudit(session.audit, { action: "created", at: this._nowIso() });
    return this.sessions.create(session);
  }

  /** @private Load + require a session by id (validated). */
  async _require(discoveryId) {
    validateDiscoveryId(discoveryId);
    return requirePdpSession(await this.sessions.findById(discoveryId), discoveryId);
  }

  /** @private Guarded state transition → persisted record. */
  async _transition(session, toState, options = {}) {
    assertPdpTransition(session.state, toState);
    const at = this._nowIso();
    const patch = {
      state: toState,
      history: [...(session.history ?? []), { from: session.state, to: toState, at, reason: options.reason }],
      updatedAt: at,
      ...(options.patch ?? {}),
    };
    if (options.audit) patch.audit = appendAudit(session.audit, options.audit);
    const updated = await this.sessions.update(session.discoveryId, patch);
    if (options.event) {
      this.events.emit(options.event, this._eventFor(updated, { previousState: session.state, reason: options.reason, ...(options.eventExtras ?? {}) }));
    }
    return updated;
  }

  /** @private Record a workflow-stage boundary + persist. */
  async _recordStage(session, stage, status, meta = {}) {
    const at = this._nowIso();
    const entry = stageEntry(stage, status, { at, ...meta });
    return this.sessions.update(session.discoveryId, {
      stage,
      stageHistory: [...(session.stageHistory ?? []), entry],
      updatedAt: at,
    });
  }

  /** @private Move an active-but-expired session to EXPIRED lazily on read. */
  async _sweepIfExpired(session) {
    if (
      isPdpSessionExpired(session, this.clock()) &&
      [PdpState.CREATED, PdpState.RESOLVING, PdpState.NEGOTIATING, PdpState.PLANNING, PdpState.RECOVERY].includes(session.state)
    ) {
      return this._transition(session, PdpState.EXPIRED, {
        reason: "ttl-elapsed",
        patch: { failureReason: PdpFailureReason.EXPIRED_SESSION },
        event: PdpEventType.WORKFLOW_EXPIRED,
      });
    }
    return null;
  }

  /** @private Emit the semantic event for a completed stage. */
  _emitSemantic(session, stage, meta) {
    const base = this._eventFor(session, { stage, ...meta });
    if (stage === WorkflowStage.DEVICES) this.events.emit(PdpEventType.DISCOVERY_RESOLVED, base);
    else if (stage === WorkflowStage.PRESENCE) this.events.emit(PdpEventType.PRESENCE_RESOLVED, base);
    else if (stage === WorkflowStage.CAPABILITIES) this.events.emit(PdpEventType.CAPABILITIES_NEGOTIATED, base);
    else if (stage === WorkflowStage.SELECTION) this.events.emit(PdpEventType.DEVICE_SELECTED, base);
  }

  /** @private Build a standard event payload from a session. */
  _eventFor(session, extras = {}) {
    return {
      discoveryId: session.discoveryId,
      requester: session.requester,
      requesterDevice: session.requesterDevice,
      targetUser: session.targetUser,
      state: session.state,
      ...extras,
    };
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

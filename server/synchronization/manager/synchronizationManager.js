/**
 * @module synchronization/manager
 *
 * The **Synchronization Manager** — the reusable orchestrator for Layer 9, Sprint 1. It registers each
 * device's replica (its version maps), computes what a target device is MISSING relative to a source
 * (delta detection), generates a DETERMINISTIC synchronization plan, and drives a resumable
 * synchronization SESSION: dispensing operations to the client, tracking applied progress, and
 * advancing the target replica's versions on completion.
 *
 * @important The engine answers only *"what state is missing?"* + *"how should it be synchronized?"*.
 * It does NOT move bytes (the Layer-8 Data Plane transports the already-encrypted content) and does NOT
 * implement conflict resolution, replica merge, distributed consensus, or group synchronization — those
 * are Sprint 2. Sync here is DIRECTIONAL (target catches up to a source); the `conflict` seams are inert.
 *
 * @security Operates on VERSION METADATA + entity IDs ONLY — never plaintext, ciphertext, or keys. The
 * no-plaintext deep scan runs before every persist. Sessions are owner-scoped.
 *
 * @distributed Plans are deterministic (a `deterministicHash` proves it), so a paused session resumes
 * from a cursor without re-planning and two replicas agree on the same plan. The manager is stateless
 * beyond its repository, so it scales horizontally.
 *
 * @example
 * ```js
 * const mgr = new SynchronizationManager({ ...createInMemorySyncRepository() });
 * await mgr.registerReplica({ deviceId: "phone", userId: "u1", categoryVersions: phoneVersions });
 * await mgr.registerReplica({ deviceId: "laptop", userId: "u1", categoryVersions: laptopVersions });
 * const { session, plan } = await mgr.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
 * const ops = await mgr.getNextOperations({ sessionId: session.sessionId, max: 10 }); // client fetches these
 * await mgr.recordProgress({ sessionId: session.sessionId, appliedOpIds: ops.map(o => o.opId) });
 * ```
 */

import crypto from "node:crypto";
import {
  SyncSessionState,
  SyncDirection,
  SyncEventType,
  SyncFailureReason,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_BATCH_SIZE,
  isTerminalSessionState,
} from "../types/types.js";
import { SyncError, SessionExpiredError } from "../errors.js";
import { assertTransition } from "../sessions/sessionLifecycle.js";
import { createReplica, applyEntityVersions, totalEntities } from "../state/replicaState.js";
import { computeDelta, isDeltaEmpty, validateDelta } from "../delta/deltaDetector.js";
import { createSyncPlan, remainingOperations, validatePlan } from "../planner/syncPlanner.js";
import { SyncQueue } from "../queue/syncQueue.js";
import { SyncEventBus } from "../events/events.js";
import {
  validateReplicaRegistration,
  validateStartSyncRequest,
  validateOperationReport,
  validateRef,
  requireReplica,
  requireSession,
  assertNotExpired,
  assertNoPlaintext,
  validateRepository,
} from "../validators/validators.js";
import { toPublicReplica, toPublicSession, toPublicPlan, toPublicDelta, toProgress, toOperation, toSyncStatus } from "../serializers/serializer.js";

export class SynchronizationManager {
  constructor(deps = {}) {
    validateRepository({ replicas: deps.replicas, sessions: deps.sessions, plans: deps.plans });
    this.replicas = deps.replicas;
    this.sessions = deps.sessions;
    this.plans = deps.plans;
    this.deltaHistory = deps.deltaHistory ?? null;
    this.progressStore = deps.progress ?? null;
    this.auditStore = deps.audit ?? null;
    this.events = deps.events ?? new SyncEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    /** @type {Map<string, SyncQueue>} sessionId -> live operation queue (rebuildable from the plan) */
    this._queues = new Map();
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === replica management ==================================================

  /**
   * Register (or update) a device's replica state. Idempotent + monotonic — an update advances the
   * version maps, never regressing them. @returns {Promise<object>} the replica DTO
   * @param {{ replicaId?, deviceId, userId?, categoryVersions?, metadata? }} params
   */
  async registerReplica(params) {
    validateReplicaRegistration(params);
    const existing = params.replicaId ? await this.replicas.findById(params.replicaId) : await this.replicas.findByDevice(params.deviceId);
    if (existing) return this.updateReplica(existing.replicaId, { categoryVersions: params.categoryVersions, metadata: params.metadata });
    const replica = createReplica({ ...params, clock: this.clock, idGenerator: this.idGenerator });
    assertNoPlaintext(replica, "replica");
    const stored = await this.replicas.upsert(replica);
    this.events.emit(SyncEventType.REPLICA_REGISTERED, { replicaId: stored.replicaId, deviceId: stored.deviceId, userId: stored.userId });
    return toPublicReplica(stored);
  }

  /** Advance a replica's version maps (monotonic merge across categories). */
  async updateReplica(replicaId, patch = {}) {
    validateRef(replicaId, "replica identifier");
    const replica = requireReplica(await this.replicas.findById(String(replicaId)), replicaId);
    let categoryVersions = replica.categoryVersions;
    if (patch.categoryVersions) {
      assertNoPlaintext(patch.categoryVersions, "categoryVersions");
      for (const [category, block] of Object.entries(patch.categoryVersions)) {
        const entities = block?.entities ?? block ?? {};
        const refs = Object.entries(entities).map(([entityId, version]) => ({ entityId, version }));
        categoryVersions = applyEntityVersions(categoryVersions, category, refs);
      }
    }
    const updated = await this.replicas.update(replicaId, {
      categoryVersions,
      metadata: patch.metadata ? { ...(replica.metadata ?? {}), ...patch.metadata } : replica.metadata,
      pendingChanges: totalEntities(categoryVersions),
      syncVersion: (replica.syncVersion ?? 1) + 1,
      version: (replica.version ?? 0) + 1,
    });
    this.events.emit(SyncEventType.REPLICA_UPDATED, { replicaId: updated.replicaId, deviceId: updated.deviceId, syncVersion: updated.syncVersion });
    return toPublicReplica(updated);
  }

  /** A replica by id (or by device). */
  async getReplica({ replicaId, deviceId }) {
    const replica = replicaId ? await this.replicas.findById(replicaId) : await this.replicas.findByDevice(deviceId);
    return toPublicReplica(requireReplica(replica, replicaId ?? deviceId));
  }

  // === delta (what is missing?) ============================================

  /**
   * Compute what a target replica is MISSING relative to a source. Read-only; produces no session.
   * @param {{ targetReplicaId?, targetDeviceId?, sourceReplicaId?, sourceDeviceId?, categories?, since? }} params
   * @returns {Promise<object>} the delta DTO
   */
  async computeMissingState(params) {
    const { source, target } = await this._resolvePair(params);
    const delta = computeDelta(source, target, { categories: params.categories, since: params.since, now: this.clock(), sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId });
    validateDelta(delta);
    return toPublicDelta(delta, { includeRefs: params.includeRefs });
  }

  // === synchronization sessions ============================================

  /**
   * Start a synchronization session: compute the delta, generate a deterministic plan, and create a
   * RUNNING session with an operation queue. @returns {Promise<{ session, plan, delta }>}
   * @param {{ targetReplicaId?, targetDeviceId?, sourceReplicaId?, sourceDeviceId?, categories?, since?, batchSize?, direction?, actingDevice? }} params
   */
  async startSync(params) {
    validateStartSyncRequest(params);
    const { source, target } = await this._resolvePair(params);
    if (params.actingDevice) this._assertOwner(target, params.actingDevice);

    const sessionId = `sync:${this.idGenerator()}`;
    const now = this.clock();
    const delta = computeDelta(source, target, { categories: params.categories, since: params.since, now, sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId });
    validateDelta(delta);
    this.events.emit(SyncEventType.DELTA_GENERATED, { sessionId, totalItems: delta.totalItems, sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId });
    if (this.deltaHistory) await this.deltaHistory.record({ sessionId, sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, totalItems: delta.totalItems, byCategory: countByCategory(delta), at: this._nowIso() });

    const plan = createSyncPlan(delta, { sessionId, batchSize: params.batchSize ?? this.batchSize, now });
    validatePlan(plan);
    await this.plans.save(sessionId, plan);
    this.events.emit(SyncEventType.SYNC_PLANNED, { sessionId, totalOperations: plan.totalOperations, totalItems: plan.plannedItems, deterministicHash: plan.deterministicHash });

    const session = {
      sessionId,
      sourceReplicaId: source.replicaId,
      targetReplicaId: target.replicaId,
      deviceId: target.deviceId,
      userId: target.userId,
      direction: params.direction ?? SyncDirection.PULL,
      state: isDeltaEmpty(delta) ? SyncSessionState.CREATED : SyncSessionState.CREATED,
      categories: delta.metadata.categories,
      planId: plan.planId,
      progress: { totalOperations: plan.totalOperations, completedOperations: 0, totalItems: plan.plannedItems, appliedItems: 0 },
      resumeCursor: 0,
      recovery: { resumable: true },
      failureReason: null,
      createdAt: this._nowIso(),
      updatedAt: this._nowIso(),
      expiresAt: new Date(now + this.sessionTtlMs).toISOString(),
      version: 1,
      schemaVersion: 1,
    };
    assertNoPlaintext(session, "session");
    let stored = await this.sessions.create(session);
    this.events.emit(SyncEventType.SYNC_STARTED, { sessionId, targetReplicaId: target.replicaId, totalItems: plan.plannedItems });

    // Empty delta → immediately complete; else transition to RUNNING + build the queue.
    if (isDeltaEmpty(delta)) {
      stored = await this._complete(stored, source);
    } else {
      stored = await this._transition(stored, SyncSessionState.RUNNING, { reason: "started" });
      this._queue(sessionId).loadFromPlan(plan, 0);
    }
    return { session: toPublicSession(stored), plan: toPublicPlan(plan), delta: toPublicDelta(delta) };
  }

  /**
   * Dispense the next operations for the client to fetch + apply. Marks them in-progress.
   * @param {{ sessionId, max?, actingDevice? }} params @returns {Promise<object[]>} operations (entity refs)
   */
  async getNextOperations(params) {
    const session = await this._requireSession(params.sessionId);
    if (params.actingDevice) this._assertOwner(session, params.actingDevice);
    assertNotExpired(session, this.clock());
    if (session.state !== SyncSessionState.RUNNING) return [];
    const queue = await this._ensureQueue(session);
    return queue.dequeue(params.max ?? Infinity).map(toOperation);
  }

  /**
   * Record which operations the client applied (or failed). Advances progress; on full completion the
   * target replica's versions advance + `lastSuccessfulSync` is set. @returns {Promise<object>} status
   * @param {{ sessionId, appliedOpIds?, failedOpIds?, actingDevice? }} params
   */
  async recordProgress(params) {
    validateOperationReport(params);
    let session = await this._requireSession(params.sessionId);
    if (params.actingDevice) this._assertOwner(session, params.actingDevice);
    if (isTerminalSessionState(session.state)) return toSyncStatus(session);
    assertNotExpired(session, this.clock());
    const queue = await this._ensureQueue(session);

    for (const opId of params.appliedOpIds ?? []) {
      if (queue.markApplied(opId)) this.events.emit(SyncEventType.OPERATION_APPLIED, { sessionId: session.sessionId, opId });
    }
    for (const opId of params.failedOpIds ?? []) {
      const outcome = queue.markFailed(opId);
      this.events.emit(SyncEventType.OPERATION_FAILED, { sessionId: session.sessionId, opId, outcome });
    }

    // The queue holds the full plan, so its counts are the authoritative totals (correct across resume).
    const snap = queue.snapshot();
    session = await this.sessions.update(session.sessionId, {
      progress: { ...session.progress, completedOperations: snap.applied, appliedItems: queue.appliedItemCount },
      resumeCursor: snap.applied,
      version: (session.version ?? 0) + 1,
    });
    if (this.progressStore) await this.progressStore.save(session.sessionId, toProgress(session));
    this.events.emit(SyncEventType.SYNC_PROGRESS, { sessionId: session.sessionId, completedOperations: snap.applied, totalOperations: snap.total, appliedItems: queue.appliedItemCount });

    if (queue.isComplete) {
      const source = await this.replicas.findById(session.sourceReplicaId);
      session = await this._complete(session, source);
    } else if (queue.hasExhausted) {
      session = await this._fail(session, SyncFailureReason.INVALID_PLAN);
    }
    return toSyncStatus(session);
  }

  /** Pause a running session. */
  async pauseSync(sessionId, options = {}) {
    let session = await this._requireSession(sessionId);
    if (options.actingDevice) this._assertOwner(session, options.actingDevice);
    if (session.state !== SyncSessionState.RUNNING) return toPublicSession(session);
    this._queue(sessionId).pause();
    session = await this._transition(session, SyncSessionState.PAUSED, { reason: "paused", event: SyncEventType.SYNC_PAUSED });
    return toPublicSession(session);
  }

  /**
   * Resume a paused session — rebuilds the operation queue from the persisted plan + resume cursor
   * (deterministic; re-sends only the not-yet-applied operations). @returns {Promise<object>}
   */
  async resumeSync(sessionId, options = {}) {
    let session = await this._requireSession(sessionId);
    if (options.actingDevice) this._assertOwner(session, options.actingDevice);
    assertNotExpired(session, this.clock());
    if (session.state !== SyncSessionState.PAUSED) return toPublicSession(session);
    const plan = await this.plans.get(sessionId);
    const queue = this._queue(sessionId);
    queue.clear();
    queue.loadFromPlan(plan, session.resumeCursor ?? 0);
    queue.resume();
    session = await this._transition(session, SyncSessionState.RUNNING, { reason: "resumed", event: SyncEventType.SYNC_RESUMED });
    return toPublicSession(session);
  }

  /** Cancel a session. */
  async cancelSync(sessionId, options = {}) {
    let session = await this._requireSession(sessionId);
    if (options.actingDevice) this._assertOwner(session, options.actingDevice);
    if (isTerminalSessionState(session.state)) return toPublicSession(session);
    session = await this._transition(session, SyncSessionState.CANCELLED, { reason: options.reason ?? "cancelled", event: SyncEventType.SYNC_CANCELLED, patch: { failureReason: "cancelled" } });
    this._queues.delete(sessionId);
    return toPublicSession(session);
  }

  /** Expire stale sessions (past TTL). Driven by a sweep or directly. */
  async sweepExpired(now = this.clock()) {
    const stale = await this.sessions.listExpired(new Date(now).toISOString());
    let expired = 0;
    for (const session of stale) {
      try {
        await this._transition(session, SyncSessionState.EXPIRED, { reason: "ttl", patch: { failureReason: SyncFailureReason.EXPIRED_SESSION } });
        this._queues.delete(session.sessionId);
        expired++;
      } catch {
        /* skip */
      }
    }
    return { expired };
  }

  // === queries =============================================================

  async getSession(sessionId, options = {}) {
    const session = await this._requireSession(sessionId);
    if (options.actingDevice) this._assertOwner(session, options.actingDevice);
    return toPublicSession(session);
  }

  async getStatus(sessionId) {
    return toSyncStatus(await this._requireSession(sessionId));
  }

  async getProgress(sessionId) {
    return toProgress(await this._requireSession(sessionId));
  }

  async getPlan(sessionId, options = {}) {
    await this._requireSession(sessionId);
    const plan = await this.plans.get(sessionId);
    return plan ? toPublicPlan(plan, { includeOperations: options.includeOperations }) : null;
  }

  async listSessions(options = {}) {
    return (await this.sessions.listActive({ deviceId: options.deviceId, userId: options.userId })).map(toPublicSession);
  }

  /** Full diagnostics for a session (progress + queue + plan summary + delta history). */
  async getDiagnostics(sessionId, options = {}) {
    const session = await this._requireSession(sessionId);
    if (options.actingDevice) this._assertOwner(session, options.actingDevice);
    const plan = await this.plans.get(sessionId);
    const queue = this._queues.get(sessionId);
    return {
      session: toPublicSession(session),
      plan: plan ? toPublicPlan(plan) : null,
      queue: queue ? queue.snapshot() : null,
      deltaHistory: this.deltaHistory ? await this.deltaHistory.listBySession(sessionId, { limit: 10 }) : [],
    };
  }

  /** Aggregate control-plane health snapshot. */
  async health() {
    return { framework: "synchronization", sessions: await this.sessions.countByState(), activeQueues: this._queues.size, at: this._nowIso() };
  }

  // === internals ==========================================================

  /** @private complete a session (success) + advance the target replica's versions. */
  async _complete(session, source) {
    const plan = await this.plans.get(session.sessionId);
    // Advance the target replica to include every synced entity at the source's version.
    if (source) {
      const target = await this.replicas.findById(session.targetReplicaId);
      if (target) {
        let categoryVersions = target.categoryVersions;
        for (const op of plan?.operations ?? []) categoryVersions = applyEntityVersions(categoryVersions, op.category, op.entityRefs);
        await this.replicas.update(target.replicaId, { categoryVersions, pendingChanges: totalEntities(categoryVersions), lastSuccessfulSync: this._nowIso(), syncVersion: (target.syncVersion ?? 1) + 1, version: (target.version ?? 0) + 1 });
        this.events.emit(SyncEventType.REPLICA_UPDATED, { replicaId: target.replicaId, deviceId: target.deviceId, reason: "sync-completed" });
      }
    }
    const done = await this._transition(session, SyncSessionState.COMPLETED, { reason: "completed", patch: { progress: { ...session.progress, completedOperations: session.progress.totalOperations } } });
    this.events.emit(SyncEventType.SYNC_COMPLETED, { sessionId: session.sessionId, targetReplicaId: session.targetReplicaId, totalItems: session.progress.totalItems });
    this._queues.delete(session.sessionId);
    return done;
  }

  /** @private fail a session. */
  async _fail(session, reason) {
    const failed = await this._transition(session, SyncSessionState.FAILED, { reason, patch: { failureReason: reason } });
    this.events.emit(SyncEventType.SYNC_FAILED, { sessionId: session.sessionId, reason });
    this._queues.delete(session.sessionId);
    return failed;
  }

  /** @private resolve a source + target replica pair from ids or device ids. */
  async _resolvePair(params) {
    const target = requireReplica(params.targetReplicaId ? await this.replicas.findById(params.targetReplicaId) : await this.replicas.findByDevice(params.targetDeviceId), params.targetReplicaId ?? params.targetDeviceId);
    let source;
    if (params.sourceReplicaId) source = await this.replicas.findById(params.sourceReplicaId);
    else if (params.sourceDeviceId) source = await this.replicas.findByDevice(params.sourceDeviceId);
    else if (params.sourceVersions) source = { replicaId: "inline-source", categoryVersions: params.sourceVersions };
    requireReplica(source, params.sourceReplicaId ?? params.sourceDeviceId ?? "source");
    return { source, target };
  }

  /** @private a session's live queue (rebuilt from the plan if not resident). */
  _queue(sessionId) {
    let q = this._queues.get(sessionId);
    if (!q) {
      q = new SyncQueue();
      this._queues.set(sessionId, q);
    }
    return q;
  }

  /** @private ensure the queue is loaded from the plan (after a restart / cold read). */
  async _ensureQueue(session) {
    const q = this._queue(session.sessionId);
    if (q._ops.size === 0 && session.state === SyncSessionState.RUNNING) {
      const plan = await this.plans.get(session.sessionId);
      if (plan) q.loadFromPlan(plan, session.resumeCursor ?? 0); // pre-marks the first `cursor` ops applied
    }
    return q;
  }

  async _requireSession(sessionId) {
    validateRef(sessionId, "session identifier");
    return requireSession(await this.sessions.findById(String(sessionId)), sessionId);
  }

  _assertOwner(record, actingDevice) {
    const id = String(actingDevice);
    if (id !== String(record.deviceId) && id !== String(record.userId)) {
      throw new SyncError("Caller does not own this synchronization record", { code: "ERR_SYNC_FORBIDDEN", status: 403, reason: SyncFailureReason.UNAUTHORIZED });
    }
  }

  async _transition(session, toState, options = {}) {
    assertTransition(session.state, toState);
    const patch = { state: toState, version: (session.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "session");
    const updated = await this.sessions.update(session.sessionId, patch);
    if (options.event) this.events.emit(options.event, { sessionId: updated.sessionId, state: toState, reason: options.reason });
    return updated;
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

function countByCategory(delta) {
  const out = {};
  for (const [category, block] of Object.entries(delta.categories ?? {})) out[category] = block.count;
  return out;
}

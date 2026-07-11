/**
 * @module synchronization-reliability/manager
 *
 * The **Synchronization Reliability Manager** — the orchestrator that makes the offline-synchronization
 * + state-replication layer production-grade. It tracks a reliability record per synchronization,
 * advances a monotonic resume CHECKPOINT from sync progress, continuously scores health + replica
 * drift, and drives RECOVERY (resume-from-checkpoint / retry / restart / graceful-fail) through injected
 * hooks — all while preserving replica consistency so recovery never corrupts a replica.
 *
 * @security Operates on CONTROL-PLANE metadata + numeric aggregates ONLY — session/replica ids,
 * operation counts, conflict counts, versions, health scores. It NEVER handles message content or keys;
 * the no-plaintext deep scan runs before every persist.
 *
 * @evolution Transport-INDEPENDENT: recovery calls INJECTED hooks (the Sprint 1/2 engines + Layer 8
 * perform the real work + confirm via a subsequent checkpoint). Layer 10 (group communication) consumes
 * the frozen interfaces + the checkpoint/resume seam.
 *
 * @example
 * ```js
 * const mgr = new SyncReliabilityManager({ ...createInMemoryReliabilityRepository(), recoveryHooks });
 * await mgr.registerSync({ sessionId: "sync:1", replicaId: "r1", deviceId: "phone", userId: "u1", totalOperations: 40 });
 * await mgr.checkpoint({ syncId: "sync:1", completedOperations: 20, cursor: 20, conflicts: 1, merges: 2, replicaDrift: 20 });
 * await mgr.recover("sync:1", "device-crash"); // resume from checkpoint
 * ```
 */

import crypto from "node:crypto";
import {
  ReliabilityState,
  RecoveryOutcome,
  RecoveryAction,
  RecoveryTrigger,
  ReliabilityEventType,
  ReliabilityFailureReason,
  HealthStatus,
  Metric,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_SYNC_TTL_MS,
  DRIFT_CEILING,
  isTerminalReliabilityState,
} from "../types/types.js";
import { SyncReliabilityError } from "../errors.js";
import { assertTransition } from "./syncReliabilityLifecycle.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { advanceCheckpoint, planResume } from "../recovery/checkpoint.js";
import { resolveRetryPolicy } from "../retry/retryPolicy.js";
import { scoreHealth } from "../health/healthMonitor.js";
import { buildDiagnostics } from "../diagnostics/diagnostics.js";
import { ReliabilityEventBus } from "../events/events.js";
import { validateRegisterRequest, validateCheckpointUpdate, validateRecoveryTrigger, validateRef, requireRecord, assertNoPlaintext, validateRepository } from "../validators/validators.js";

export class SyncReliabilityManager {
  constructor(deps = {}) {
    validateRepository({ records: deps.records });
    this.records = deps.records;
    this.recoveryHistory = deps.recoveryHistory ?? null;
    this.events = deps.events ?? new ReliabilityEventBus();
    this.metrics = deps.metrics ?? null;
    this.monitor = deps.monitor ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.retryPolicy = resolveRetryPolicy(deps.retryPolicy ?? DEFAULT_RETRY_POLICY);
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_SYNC_TTL_MS;
    this.driftCeiling = deps.driftCeiling ?? DRIFT_CEILING;
    this.recoveryHooks = deps.recoveryHooks ?? {};
    this.coordinator = deps.coordinator ?? new RecoveryCoordinator({ retryPolicy: this.retryPolicy, clock: this.clock });
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === registration + checkpointing ========================================

  /** Register a synchronization for reliability tracking. Idempotent. @returns {Promise<object>} */
  async registerSync(params) {
    validateRegisterRequest(params);
    const syncId = params.syncId ?? params.sessionId;
    const existing = await this.records.findById(syncId);
    if (existing) return existing;
    const now = this.clock();
    const record = {
      syncId: String(syncId),
      sessionId: String(params.sessionId ?? syncId),
      replicaId: params.replicaId ?? null,
      deviceId: String(params.deviceId),
      userId: String(params.userId ?? params.deviceId),
      state: ReliabilityState.TRACKING,
      checkpoint: { totalOperations: params.totalOperations ?? 0, completedOperations: 0, cursor: 0, conflicts: 0, merges: 0, pendingOperations: params.totalOperations ?? 0, replicaDrift: params.totalOperations ?? 0, checkpointAt: this._nowIso() },
      health: { status: HealthStatus.HEALTHY, score: 1, progress: 0, conflictRate: 0, mergeSuccessRate: 1, replicaDrift: params.totalOperations ?? 0, stalenessMs: 0, throughput: 0 },
      recoveryCount: 0,
      resumeCount: 0,
      retryCount: 0,
      retryPolicy: resolveRetryPolicy({ ...this.retryPolicy, ...(params.retryPolicy ?? {}) }),
      metadata: params.metadata ?? {},
      failureReason: null,
      registeredAt: this._nowIso(),
      lastActivityAt: this._nowIso(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      version: 1,
      schemaVersion: 1,
    };
    assertNoPlaintext(record, "reliability record");
    const stored = await this.records.create(record);
    this.metrics?.increment(Metric.SYNC_TOTAL);
    this.metrics?.gauge(Metric.CONCURRENT_SYNCS, (await this.records.listActive()).length);
    this.events.emit(ReliabilityEventType.SYNC_REGISTERED, { syncId: stored.syncId, sessionId: stored.sessionId, replicaId: stored.replicaId, totalOperations: params.totalOperations });
    return stored;
  }

  /** Record a progress checkpoint (monotonic). Recomputes health + drift; toggles TRACKING ↔ DEGRADED. */
  async checkpoint(params) {
    validateRef(params.syncId, "sync identifier");
    validateCheckpointUpdate(params);
    let record = await this._require(params.syncId);
    if (isTerminalReliabilityState(record.state)) return record;
    const now = this.clock();
    const checkpoint = advanceCheckpoint(record.checkpoint, params, { now });

    this.metrics?.recordConflictsMerges(Math.max(0, (checkpoint.conflicts ?? 0) - (record.checkpoint?.conflicts ?? 0)), Math.max(0, (checkpoint.merges ?? 0) - (record.checkpoint?.merges ?? 0)));
    const elapsedSec = Math.max(0.001, (now - new Date(record.registeredAt).getTime()) / 1000);
    this.metrics?.recordProgress({ throughput: (checkpoint.completedOperations ?? 0) / elapsedSec, replicaDrift: checkpoint.replicaDrift, pendingOperations: checkpoint.pendingOperations, queueDepth: checkpoint.pendingOperations });

    record = await this.records.update(params.syncId, { checkpoint, lastActivityAt: new Date(now).toISOString(), version: (record.version ?? 0) + 1 });
    const health = scoreHealth(record, { now });
    record = await this._applyHealth(record, health, now);
    if ((checkpoint.replicaDrift ?? 0) >= this.driftCeiling) this.events.emit(ReliabilityEventType.DRIFT_DETECTED, { syncId: record.syncId, drift: checkpoint.replicaDrift });
    this.events.emit(ReliabilityEventType.CHECKPOINT_RECORDED, { syncId: record.syncId, completedOperations: checkpoint.completedOperations, cursor: checkpoint.cursor, progress: health.progress });
    return record;
  }

  /** Mark a synchronization completed (success). */
  async complete(syncId, options = {}) {
    let record = await this._require(syncId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (record.state === ReliabilityState.COMPLETED) return record;
    record = await this._transition(record, ReliabilityState.COMPLETED, { reason: "completed", patch: { lastActivityAt: this._nowIso() } });
    const latency = this.clock() - new Date(record.registeredAt).getTime();
    this.metrics?.recordSync(true, latency);
    this.metrics?.gauge(Metric.CONCURRENT_SYNCS, (await this.records.listActive()).length);
    this.events.emit(ReliabilityEventType.SYNC_COMPLETED, { syncId: record.syncId, latencyMs: latency });
    return record;
  }

  // === interruption + recovery =============================================

  /** Flag a synchronization as interrupted (optionally auto-recover). */
  async reportInterruption(syncId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(syncId);
    if (isTerminalReliabilityState(record.state)) return record;
    const now = options.now ?? this.clock();
    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: record.metadata?.recoveringSince ?? new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.SYNC_INTERRUPTED,
        eventPayload: { trigger },
      });
    }
    if (options.autoRecover) return this.recover(syncId, trigger, { ...options, now });
    return record;
  }

  /**
   * Run a recovery for an interrupted (or degraded) synchronization. Resolves the action for the
   * trigger, enforces bounded attempts + a retry budget + a recovery timeout, and always PRESERVES the
   * checkpoint. @returns {Promise<{ outcome, record, resumePlan }>}
   */
  async recover(syncId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(syncId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new SyncReliabilityError(`Cannot recover a ${record.state} synchronization`, { code: "ERR_SYNCREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const policy = resolveRetryPolicy(record.retryPolicy ?? this.retryPolicy);

    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.SYNC_INTERRUPTED,
        eventPayload: { trigger },
      });
    }

    const recoveringSince = new Date(record.metadata?.recoveringSince ?? new Date(now).toISOString()).getTime();
    const attempt = (record.recoveryCount ?? 0) + 1;
    const { recoverable } = this.coordinator.resolvePlan(trigger);
    if (!recoverable) return this._gracefulFail(record, ReliabilityFailureReason.UNRECOVERABLE, now, recoveringSince);
    if (now - recoveringSince > policy.recoveryTimeoutMs) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince);

    record = await this._transition(record, ReliabilityState.RECOVERING, { patch: { recoveryCount: attempt, retryCount: (record.retryCount ?? 0) + 1 }, event: ReliabilityEventType.RECOVERY_STARTED, eventPayload: { trigger, attempt } });
    this.metrics?.increment(Metric.RECOVERY_TOTAL);
    this.metrics?.recordRetry();

    const result = await this.coordinator.run({ record, trigger, attempt, hooks: this.recoveryHooks });
    return this._applyRecoveryOutcome(record, trigger, result, now, recoveringSince);
  }

  /** @private apply a recovery result → success or (bounded) failure. */
  async _applyRecoveryOutcome(record, trigger, result, now, recoveringSince) {
    const recoveryTimeMs = now - recoveringSince;
    if (result.outcome === RecoveryOutcome.RECOVERED) {
      record = await this._transition(record, ReliabilityState.TRACKING, { reason: result.action, patch: { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso(), metadata: { ...(record.metadata ?? {}), recoveringSince: null } } });
      this.metrics?.recordRecovery(true, recoveryTimeMs);
      this.metrics?.recordResume();
      this.events.emit(ReliabilityEventType.SYNC_RESUMED, { syncId: record.syncId, resumePlan: result.resumePlan });
      this.events.emit(ReliabilityEventType.RECOVERY_SUCCEEDED, { syncId: record.syncId, action: result.action, recoveryTimeMs });
      await this.recoveryHistory?.record({ syncId: record.syncId, trigger, action: result.action, outcome: result.outcome, attempt: record.recoveryCount, at: this._nowIso() });
      return { outcome: result.outcome, record, resumePlan: result.resumePlan ?? null };
    }

    this.metrics?.recordRecovery(false, recoveryTimeMs);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { syncId: record.syncId, action: result.action, attempt: record.recoveryCount });
    await this.recoveryHistory?.record({ syncId: record.syncId, trigger, action: result.action, outcome: result.outcome, attempt: record.recoveryCount, at: this._nowIso() });
    if (result.outcome === RecoveryOutcome.EXHAUSTED || !result.recoverable) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince);
    record = await this._transition(record, ReliabilityState.INTERRUPTED, { reason: "recovery-attempt-failed" });
    return { outcome: RecoveryOutcome.FAILED, record, resumePlan: result.resumePlan ?? null };
  }

  /** @private graceful failure — terminal FAILED with the checkpoint intact (resumable later). */
  async _gracefulFail(record, reason, now, recoveringSince) {
    const failed = await this._transition(record, ReliabilityState.FAILED, { reason, patch: { failureReason: reason } });
    this.metrics?.recordRecovery(false, now - (recoveringSince ?? now));
    this.metrics?.recordSync(false);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { syncId: record.syncId, reason });
    this.events.emit(ReliabilityEventType.SYNC_FAILED, { syncId: record.syncId, reason });
    await this.recoveryHistory?.record({ syncId: record.syncId, outcome: RecoveryOutcome.EXHAUSTED, action: RecoveryAction.GRACEFUL_FAIL, at: this._nowIso() });
    return { outcome: RecoveryOutcome.EXHAUSTED, record: failed, resumePlan: null };
  }

  /** Explicitly resume a synchronization from its checkpoint. */
  async resume(syncId, options = {}) {
    let record = await this._require(syncId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new SyncReliabilityError(`Cannot resume a ${record.state} synchronization`, { code: "ERR_SYNCREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const plan = planResume(record.checkpoint, { now });
    const ok = await this._callHook(this.recoveryHooks.resumeFromCheckpoint, record, plan);
    if (record.state !== ReliabilityState.TRACKING) record = await this._transition(record, ReliabilityState.TRACKING, { reason: "resumed", patch: { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() } });
    else record = await this.records.update(syncId, { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() });
    this.metrics?.recordResume();
    this.events.emit(ReliabilityEventType.SYNC_RESUMED, { syncId, resumePlan: plan });
    return { resumePlan: plan, resumed: ok, record };
  }

  /** Abandon (cancel) a tracked synchronization. */
  async abandon(syncId, options = {}) {
    let record = await this._require(syncId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) return record;
    record = await this._transition(record, ReliabilityState.ABANDONED, { reason: options.reason ?? "abandoned", patch: { failureReason: "abandoned" } });
    this.events.emit(ReliabilityEventType.SYNC_FAILED, { syncId, reason: "abandoned" });
    return record;
  }

  // === queries =============================================================

  async getRecord(syncId, options = {}) {
    const record = await this._require(syncId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    return record;
  }

  async getHealth(syncId) {
    return scoreHealth(await this._require(syncId), { now: this.clock() });
  }

  async getDiagnostics(syncId, options = {}) {
    const record = await this._require(syncId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    const recoveryHistory = this.recoveryHistory ? await this.recoveryHistory.listBySync(syncId, { limit: 20 }) : [];
    return buildDiagnostics({ record, recoveryHistory, now: this.clock() });
  }

  async listSyncs(options = {}) {
    if (options.userId) return this.records.listByUser(options.userId, { state: options.state, limit: options.limit });
    return this.records.listActive();
  }

  async listStalled(now, timeoutMs) {
    return this.records.listStalled(now ?? this.clock(), timeoutMs ?? this.stallTimeoutMs);
  }

  async health() {
    const counts = await this.records.countByState();
    const active = await this.records.listActive();
    return {
      framework: "synchronization-reliability",
      states: counts,
      activeSyncs: active.length,
      syncSuccessRate: this.metrics?.syncSuccessRate?.() ?? null,
      recoverySuccessRate: this.metrics?.recoverySuccessRate?.() ?? null,
      conflictRate: this.metrics?.conflictRate?.() ?? null,
      at: this._nowIso(),
    };
  }

  // === internals ==========================================================

  async _applyHealth(record, health, now) {
    const prevStatus = record.health?.status;
    let next = record;
    if (health.status === HealthStatus.HEALTHY && record.state === ReliabilityState.DEGRADED) next = await this._transition(record, ReliabilityState.TRACKING, { reason: "health-recovered", patch: { health } });
    else if (health.status !== HealthStatus.HEALTHY && record.state === ReliabilityState.TRACKING) next = await this._transition(record, ReliabilityState.DEGRADED, { reason: "health-degraded", patch: { health } });
    else next = await this.records.update(record.syncId, { health, version: (record.version ?? 0) + 1 });
    this.metrics?.gauge(Metric.HEALTH_SCORE, health.score);
    if (prevStatus !== health.status) this.events.emit(ReliabilityEventType.HEALTH_CHANGED, { syncId: record.syncId, status: health.status, score: health.score, conflictRate: health.conflictRate });
    return next;
  }

  async _require(syncId) {
    validateRef(syncId, "sync identifier");
    return requireRecord(await this.records.findById(String(syncId)), syncId);
  }

  _assertOwner(record, actingDevice) {
    const id = String(actingDevice);
    if (id !== String(record.deviceId) && id !== String(record.userId)) {
      throw new SyncReliabilityError("Caller does not own this synchronization", { code: "ERR_SYNCREL_FORBIDDEN", status: 403, reason: ReliabilityFailureReason.UNAUTHORIZED });
    }
  }

  async _transition(record, toState, options = {}) {
    assertTransition(record.state, toState);
    const patch = { state: toState, version: (record.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "reliability record");
    const updated = await this.records.update(record.syncId, patch);
    this.events.emit(ReliabilityEventType.STATE_CHANGED, { syncId: updated.syncId, from: record.state, to: toState, reason: options.reason });
    if (options.event) this.events.emit(options.event, { syncId: updated.syncId, ...(options.eventPayload ?? {}) });
    return updated;
  }

  async _callHook(hook, ...args) {
    if (typeof hook !== "function") return true;
    try {
      return (await hook(...args)) !== false;
    } catch {
      return false;
    }
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

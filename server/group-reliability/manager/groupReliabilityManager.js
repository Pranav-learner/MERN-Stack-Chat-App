/**
 * @module group-reliability/manager
 *
 * The **Group Reliability Manager** — the orchestrator that makes the Group Communication platform
 * production-grade. It tracks a reliability record per GROUP OPERATION (group-message / fan-out / rekey
 * / membership-update / replica-sync / offline-delivery), advances a monotonic resume CHECKPOINT from
 * operation progress, continuously scores health + backlog, and drives RECOVERY (resume-from-checkpoint
 * / retry / replan / graceful-fail) through injected hooks — all while preserving consistency so
 * recovery never corrupts group state.
 *
 * @security Operates on group CONTROL-PLANE metadata + numeric aggregates ONLY — group/operation ids,
 * target counts, failure counts, key versions, health scores. It NEVER handles message content or keys;
 * the no-plaintext deep scan runs before every persist. Every mutating op is owner-scoped + audited.
 *
 * @evolution Transport-INDEPENDENT: recovery calls INJECTED hooks (the Sprint-2 engine re-sends failed
 * fan-out legs / re-distributes a rekey / resumes a group sync + confirms via a subsequent checkpoint).
 * Sprint 4 (read receipts) consumes the frozen interfaces + the checkpoint/resume + event seams.
 *
 * @example
 * ```js
 * const mgr = new GroupReliabilityManager({ ...createInMemoryGroupReliabilityRepository(), recoveryHooks });
 * await mgr.registerOperation({ operationId: "op:1", groupId: "g", operationType: "fan-out", deviceId: "alice", totalTargets: 40 });
 * await mgr.checkpoint({ operationId: "op:1", completedTargets: 20, cursor: 20, failedTargets: 2, pendingTargets: 18 });
 * await mgr.recover("op:1", "failed-fanout"); // resume from checkpoint
 * ```
 */

import crypto from "node:crypto";
import {
  ReliabilityState,
  RecoveryOutcome,
  RecoveryAction,
  ReliabilityEventType,
  ReliabilityFailureReason,
  HealthStatus,
  Metric,
  GroupOperationType,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_OPERATION_TTL_MS,
  BACKLOG_SIGNAL_THRESHOLD,
  isTerminalReliabilityState,
} from "../types/types.js";
import { GroupReliabilityError } from "../errors.js";
import { assertTransition } from "./groupReliabilityLifecycle.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { advanceCheckpoint, planResume } from "../recovery/checkpoint.js";
import { resolveRetryPolicy } from "../retry/retryPolicy.js";
import { scoreHealth, scoreGroupHealth } from "../health/healthMonitor.js";
import { buildDiagnostics } from "../diagnostics/diagnostics.js";
import { GroupReliabilityEventBus } from "../events/events.js";
import { auditOperation } from "../security/securityAudit.js";
import { validateRegisterRequest, validateCheckpointUpdate, validateRecoveryTrigger, validateRef, requireRecord, assertNoPlaintext, validateRepository } from "../validators/validators.js";

export class GroupReliabilityManager {
  constructor(deps = {}) {
    validateRepository({ records: deps.records });
    this.records = deps.records;
    this.recoveryHistory = deps.recoveryHistory ?? null;
    this.audit = deps.audit ?? null;
    this.events = deps.events ?? new GroupReliabilityEventBus();
    this.metrics = deps.metrics ?? null;
    this.monitor = deps.monitor ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.retryPolicy = resolveRetryPolicy(deps.retryPolicy ?? DEFAULT_RETRY_POLICY);
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_OPERATION_TTL_MS;
    this.backlogThreshold = deps.backlogThreshold ?? BACKLOG_SIGNAL_THRESHOLD;
    this.recoveryHooks = deps.recoveryHooks ?? {};
    this.coordinator = deps.coordinator ?? new RecoveryCoordinator({ retryPolicy: this.retryPolicy, clock: this.clock });
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === registration + checkpointing ========================================

  /** Register a group operation for reliability tracking. Idempotent. @returns {Promise<object>} */
  async registerOperation(params) {
    validateRegisterRequest(params);
    const operationId = params.operationId ?? params.groupId;
    const existing = await this.records.findById(operationId);
    if (existing) return existing;
    const now = this.clock();
    const total = params.totalTargets ?? 0;
    const record = {
      operationId: String(operationId),
      groupId: String(params.groupId),
      operationType: params.operationType,
      deviceId: String(params.deviceId),
      userId: String(params.userId ?? params.deviceId),
      state: ReliabilityState.TRACKING,
      checkpoint: { totalTargets: total, completedTargets: 0, cursor: 0, failedTargets: 0, pendingTargets: total, retriedTargets: 0, drift: total, checkpointAt: this._nowIso() },
      health: { status: HealthStatus.HEALTHY, score: 1, progress: 0, failureRate: 0, pending: total, stalenessMs: 0, throughput: 0 },
      keyVersion: params.keyVersion ?? null,
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
    this.metrics?.increment(Metric.OPERATION_TOTAL);
    if (params.operationType === GroupOperationType.MEMBERSHIP_UPDATE) this.metrics?.recordMembershipChange();
    if (params.operationType === GroupOperationType.REKEY) this.metrics?.recordKeyRotation();
    this.metrics?.gauge(Metric.CONCURRENT_OPERATIONS, (await this.records.listActive()).length);
    await this._audit("register", stored, params.deviceId);
    this.events.emit(ReliabilityEventType.OPERATION_REGISTERED, { operationId: stored.operationId, groupId: stored.groupId, operationType: stored.operationType, totalTargets: total });
    return stored;
  }

  /** Record a progress checkpoint (monotonic). Recomputes health + backlog; toggles TRACKING ↔ DEGRADED. */
  async checkpoint(params) {
    validateRef(params.operationId, "operation identifier");
    validateCheckpointUpdate(params);
    let record = await this._require(params.operationId);
    if (isTerminalReliabilityState(record.state)) return record;
    const now = this.clock();
    const checkpoint = advanceCheckpoint(record.checkpoint, params, { now });

    const elapsedSec = Math.max(0.001, (now - new Date(record.registeredAt).getTime()) / 1000);
    this.metrics?.recordProgress({ throughput: (checkpoint.completedTargets ?? 0) / elapsedSec, replicaDrift: checkpoint.drift, pendingOperations: checkpoint.pendingTargets, offlineQueueSize: record.operationType === GroupOperationType.OFFLINE_DELIVERY ? checkpoint.pendingTargets : undefined });

    record = await this.records.update(params.operationId, { checkpoint, lastActivityAt: new Date(now).toISOString(), version: (record.version ?? 0) + 1 });
    const health = scoreHealth(record, { now });
    record = await this._applyHealth(record, health, now);
    if ((checkpoint.pendingTargets ?? 0) >= this.backlogThreshold) this.events.emit(ReliabilityEventType.BACKLOG_DETECTED, { operationId: record.operationId, groupId: record.groupId, backlog: checkpoint.pendingTargets });
    this.events.emit(ReliabilityEventType.CHECKPOINT_RECORDED, { operationId: record.operationId, completedTargets: checkpoint.completedTargets, cursor: checkpoint.cursor, progress: health.progress });
    return record;
  }

  /** Mark a group operation completed (success). */
  async complete(operationId, options = {}) {
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (record.state === ReliabilityState.COMPLETED) return record;
    record = await this._transition(record, ReliabilityState.COMPLETED, { reason: "completed", patch: { lastActivityAt: this._nowIso() } });
    const latency = this.clock() - new Date(record.registeredAt).getTime();
    this.metrics?.recordOperation(true);
    if (record.operationType === GroupOperationType.GROUP_MESSAGE || record.operationType === GroupOperationType.FAN_OUT) this.metrics?.recordMessage({ groupId: record.groupId, targets: record.checkpoint?.totalTargets, latencyMs: latency });
    if (record.operationType === GroupOperationType.REPLICA_SYNC) this.metrics?.recordSyncLatency(latency);
    this.metrics?.gauge(Metric.CONCURRENT_OPERATIONS, (await this.records.listActive()).length);
    await this._audit("complete", record, options.actingDevice);
    this.events.emit(ReliabilityEventType.OPERATION_COMPLETED, { operationId: record.operationId, groupId: record.groupId, latencyMs: latency });
    return record;
  }

  // === interruption + recovery =============================================

  /** Flag a group operation as interrupted (optionally auto-recover). */
  async reportInterruption(operationId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(operationId);
    if (isTerminalReliabilityState(record.state)) return record;
    const now = options.now ?? this.clock();
    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: record.metadata?.recoveringSince ?? new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.OPERATION_INTERRUPTED,
        eventPayload: { trigger, groupId: record.groupId },
      });
    }
    if (options.autoRecover) return this.recover(operationId, trigger, { ...options, now });
    return record;
  }

  /**
   * Run a recovery for an interrupted (or degraded) group operation. Resolves the action for the
   * trigger, enforces bounded attempts + a retry budget + a recovery timeout, and always PRESERVES the
   * checkpoint. @returns {Promise<{ outcome, record, resumePlan }>}
   */
  async recover(operationId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new GroupReliabilityError(`Cannot recover a ${record.state} operation`, { code: "ERR_GROUPREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const policy = resolveRetryPolicy(record.retryPolicy ?? this.retryPolicy);

    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.OPERATION_INTERRUPTED,
        eventPayload: { trigger, groupId: record.groupId },
      });
    }

    const recoveringSince = new Date(record.metadata?.recoveringSince ?? new Date(now).toISOString()).getTime();
    const attempt = (record.recoveryCount ?? 0) + 1;
    const { recoverable } = this.coordinator.resolvePlan(trigger);
    if (!recoverable) return this._gracefulFail(record, ReliabilityFailureReason.UNRECOVERABLE, now, recoveringSince, options.actingDevice);
    if (now - recoveringSince > policy.recoveryTimeoutMs) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince, options.actingDevice);

    record = await this._transition(record, ReliabilityState.RECOVERING, { patch: { recoveryCount: attempt, retryCount: (record.retryCount ?? 0) + 1 }, event: ReliabilityEventType.RECOVERY_STARTED, eventPayload: { trigger, attempt } });
    // RECOVERY_TOTAL is counted once per episode by recordRecovery() in the outcome handler.
    this.metrics?.recordRetry();

    const result = await this.coordinator.run({ record, trigger, attempt, hooks: this.recoveryHooks });
    return this._applyRecoveryOutcome(record, trigger, result, now, recoveringSince, options.actingDevice);
  }

  /** @private apply a recovery result → success or (bounded) failure. */
  async _applyRecoveryOutcome(record, trigger, result, now, recoveringSince, actingDevice) {
    const recoveryTimeMs = now - recoveringSince;
    if (result.outcome === RecoveryOutcome.RECOVERED) {
      record = await this._transition(record, ReliabilityState.TRACKING, { reason: result.action, patch: { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso(), metadata: { ...(record.metadata ?? {}), recoveringSince: null } } });
      this.metrics?.recordRecovery(true, recoveryTimeMs);
      this.metrics?.recordResume();
      await this._audit("recover", record, actingDevice, "recovered");
      this.events.emit(ReliabilityEventType.OPERATION_RESUMED, { operationId: record.operationId, resumePlan: result.resumePlan });
      this.events.emit(ReliabilityEventType.RECOVERY_SUCCEEDED, { operationId: record.operationId, action: result.action, recoveryTimeMs });
      await this.recoveryHistory?.record({ operationId: record.operationId, trigger, action: result.action, outcome: result.outcome, attempt: record.recoveryCount, at: this._nowIso() });
      return { outcome: result.outcome, record, resumePlan: result.resumePlan ?? null };
    }

    this.metrics?.recordRecovery(false, recoveryTimeMs);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { operationId: record.operationId, action: result.action, attempt: record.recoveryCount });
    await this.recoveryHistory?.record({ operationId: record.operationId, trigger, action: result.action, outcome: result.outcome, attempt: record.recoveryCount, at: this._nowIso() });
    if (result.outcome === RecoveryOutcome.EXHAUSTED || !result.recoverable) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince, actingDevice);
    record = await this._transition(record, ReliabilityState.INTERRUPTED, { reason: "recovery-attempt-failed" });
    return { outcome: RecoveryOutcome.FAILED, record, resumePlan: result.resumePlan ?? null };
  }

  /** @private graceful failure — terminal FAILED with the checkpoint intact (resumable later). */
  async _gracefulFail(record, reason, now, recoveringSince, actingDevice) {
    const failed = await this._transition(record, ReliabilityState.FAILED, { reason, patch: { failureReason: reason } });
    this.metrics?.recordRecovery(false, now - (recoveringSince ?? now));
    this.metrics?.recordOperation(false);
    await this._audit("graceful-fail", failed, actingDevice, reason);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { operationId: record.operationId, reason });
    this.events.emit(ReliabilityEventType.OPERATION_FAILED, { operationId: record.operationId, groupId: record.groupId, reason });
    await this.recoveryHistory?.record({ operationId: record.operationId, outcome: RecoveryOutcome.EXHAUSTED, action: RecoveryAction.GRACEFUL_FAIL, at: this._nowIso() });
    return { outcome: RecoveryOutcome.EXHAUSTED, record: failed, resumePlan: null };
  }

  /** Explicitly resume a group operation from its checkpoint. */
  async resume(operationId, options = {}) {
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new GroupReliabilityError(`Cannot resume a ${record.state} operation`, { code: "ERR_GROUPREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const plan = planResume(record.checkpoint, { now });
    const ok = await this._callHook(this.recoveryHooks.resumeFromCheckpoint, record, plan);
    if (record.state !== ReliabilityState.TRACKING) record = await this._transition(record, ReliabilityState.TRACKING, { reason: "resumed", patch: { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() } });
    else record = await this.records.update(operationId, { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() });
    this.metrics?.recordResume();
    this.events.emit(ReliabilityEventType.OPERATION_RESUMED, { operationId, resumePlan: plan });
    return { resumePlan: plan, resumed: ok, record };
  }

  /** Abandon (cancel) a tracked group operation. */
  async abandon(operationId, options = {}) {
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) return record;
    record = await this._transition(record, ReliabilityState.ABANDONED, { reason: options.reason ?? "abandoned", patch: { failureReason: "abandoned" } });
    await this._audit("abandon", record, options.actingDevice);
    this.events.emit(ReliabilityEventType.OPERATION_FAILED, { operationId, reason: "abandoned" });
    return record;
  }

  // === queries =============================================================

  async getRecord(operationId, options = {}) {
    const record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    return record;
  }

  async getHealth(operationId) {
    return scoreHealth(await this._require(operationId), { now: this.clock() });
  }

  /** Aggregate reliability health for a whole group (all its operations). */
  async getGroupHealth(groupId) {
    validateRef(groupId, "group identifier");
    const records = await this.records.listByGroup(groupId);
    return { groupId: String(groupId), ...scoreGroupHealth(records, { now: this.clock() }) };
  }

  async getDiagnostics(operationId, options = {}) {
    const record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    const recoveryHistory = this.recoveryHistory ? await this.recoveryHistory.listByOperation(operationId, { limit: 20 }) : [];
    return buildDiagnostics({ record, recoveryHistory, now: this.clock() });
  }

  async listOperations(options = {}) {
    if (options.groupId) return this.records.listByGroup(options.groupId, { state: options.state, limit: options.limit });
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
      framework: "group-reliability",
      states: counts,
      activeOperations: active.length,
      operationSuccessRate: this.metrics?.operationSuccessRate?.() ?? null,
      recoverySuccessRate: this.metrics?.recoverySuccessRate?.() ?? null,
      at: this._nowIso(),
    };
  }

  // === internals ==========================================================

  async _applyHealth(record, health, now) {
    const prevStatus = record.health?.status;
    let next = record;
    if (health.status === HealthStatus.HEALTHY && record.state === ReliabilityState.DEGRADED) next = await this._transition(record, ReliabilityState.TRACKING, { reason: "health-recovered", patch: { health } });
    else if (health.status !== HealthStatus.HEALTHY && record.state === ReliabilityState.TRACKING) next = await this._transition(record, ReliabilityState.DEGRADED, { reason: "health-degraded", patch: { health } });
    else next = await this.records.update(record.operationId, { health, version: (record.version ?? 0) + 1 });
    this.metrics?.gauge(Metric.HEALTH_SCORE, health.score);
    if (prevStatus !== health.status) this.events.emit(ReliabilityEventType.HEALTH_CHANGED, { operationId: record.operationId, groupId: record.groupId, status: health.status, score: health.score, failureRate: health.failureRate });
    return next;
  }

  async _require(operationId) {
    validateRef(operationId, "operation identifier");
    return requireRecord(await this.records.findById(String(operationId)), operationId);
  }

  _assertOwner(record, actingDevice) {
    const id = String(actingDevice);
    if (id !== String(record.deviceId) && id !== String(record.userId)) {
      throw new GroupReliabilityError("Caller does not own this group operation", { code: "ERR_GROUPREL_FORBIDDEN", status: 403, reason: ReliabilityFailureReason.UNAUTHORIZED });
    }
  }

  async _transition(record, toState, options = {}) {
    assertTransition(record.state, toState);
    const patch = { state: toState, version: (record.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "reliability record");
    const updated = await this.records.update(record.operationId, patch);
    this.events.emit(ReliabilityEventType.STATE_CHANGED, { operationId: updated.operationId, from: record.state, to: toState, reason: options.reason });
    if (options.event) this.events.emit(options.event, { operationId: updated.operationId, ...(options.eventPayload ?? {}) });
    return updated;
  }

  /** @private record an audit entry for a group operation (append-only; no content/keys). */
  async _audit(operation, record, actingDevice, outcome = "ok") {
    if (!this.audit?.record) return;
    try {
      await this.audit.record(auditOperation({ operation, operationId: record.operationId, groupId: record.groupId, actingDevice: actingDevice != null ? String(actingDevice) : null, outcome, at: this._nowIso() }));
    } catch {
      /* audit persistence failure must never break the group path */
    }
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

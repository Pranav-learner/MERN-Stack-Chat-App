/**
 * @module media-reliability/manager
 *
 * The **Media Reliability Manager** — the orchestrator that makes the Secure Media Platform production-
 * grade. It tracks a reliability record per MEDIA OPERATION (upload / download / streaming /
 * synchronization / pipeline), advances a monotonic resume CHECKPOINT from operation progress,
 * continuously scores health + backlog, and drives RECOVERY (resume-from-checkpoint / retry / replan /
 * graceful-fail) through injected hooks — all while preserving integrity + metadata consistency so
 * recovery never corrupts media state.
 *
 * @security Operates on media CONTROL-PLANE metadata + numeric aggregates ONLY — media/operation ids,
 * chunk/byte counts, failure counts, health scores. It NEVER handles media content or keys; the
 * no-content deep scan runs before every persist. Every mutating op is owner-scoped + audited.
 *
 * @evolution Storage-provider-INDEPENDENT: recovery calls INJECTED hooks (the Sprint-1/2 engine resumes
 * a progressive transfer / re-runs a pipeline stage / re-buffers a stream + confirms via a subsequent
 * checkpoint). Layer 12 (Distributed Hybrid Architecture) consumes the frozen interfaces + the
 * checkpoint/resume + event seams.
 *
 * @example
 * ```js
 * const mgr = new MediaReliabilityManager({ ...createInMemoryMediaReliabilityRepository(), recoveryHooks });
 * await mgr.registerOperation({ operationId: "op:1", mediaId: "m1", operationType: "upload", deviceId: "alice", totalChunks: 40, bytesTotal: 10_000_000 });
 * await mgr.checkpoint({ operationId: "op:1", completedChunks: 20, cursor: 20, bytesTransferred: 5_000_000 });
 * await mgr.recover("op:1", "interrupted-upload"); // resume from checkpoint
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
  MediaOperationType,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_OPERATION_TTL_MS,
  BACKLOG_SIGNAL_THRESHOLD,
  isTerminalReliabilityState,
} from "../types/types.js";
import { MediaReliabilityError } from "../errors.js";
import { assertTransition } from "./mediaReliabilityLifecycle.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { advanceCheckpoint, planResume } from "../recovery/checkpoint.js";
import { resolveRetryPolicy } from "../retry/retryPolicy.js";
import { scoreHealth, scoreMediaHealth } from "../health/healthMonitor.js";
import { buildDiagnostics } from "../diagnostics/diagnostics.js";
import { MediaReliabilityEventBus } from "../events/events.js";
import { auditOperation } from "../security/securityAudit.js";
import { validateRegisterRequest, validateCheckpointUpdate, validateRecoveryTrigger, validateRef, requireRecord, assertNoContent, validateRepository } from "../validators/validators.js";

export class MediaReliabilityManager {
  constructor(deps = {}) {
    validateRepository({ records: deps.records });
    this.records = deps.records;
    this.recoveryHistory = deps.recoveryHistory ?? null;
    this.audit = deps.audit ?? null;
    this.events = deps.events ?? new MediaReliabilityEventBus();
    this.metrics = deps.metrics ?? null;
    this.monitor = deps.monitor ?? null;
    this.cache = deps.cache ?? null;
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

  /** Register a media operation for reliability tracking. Idempotent. @returns {Promise<object>} */
  async registerOperation(params) {
    validateRegisterRequest(params);
    const operationId = params.operationId ?? params.mediaId;
    const existing = await this.records.findById(operationId);
    if (existing) return existing;
    const now = this.clock();
    const total = params.totalChunks ?? 0;
    const bytesTotal = params.bytesTotal ?? 0;
    const record = {
      operationId: String(operationId),
      mediaId: String(params.mediaId),
      operationType: params.operationType,
      deviceId: String(params.deviceId),
      userId: String(params.userId ?? params.deviceId),
      state: ReliabilityState.TRACKING,
      checkpoint: { totalChunks: total, completedChunks: 0, cursor: 0, failedChunks: 0, pendingChunks: total, retriedChunks: 0, bytesTotal, bytesTransferred: 0, checkpointAt: this._nowIso() },
      health: { status: HealthStatus.HEALTHY, score: 1, progress: 0, failureRate: 0, pending: total, stalenessMs: 0, throughput: 0 },
      storageProvider: params.storageProvider ?? null,
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
    assertNoContent(record, "reliability record");
    const stored = await this.records.create(record);
    this.metrics?.increment(Metric.OPERATION_TOTAL);
    this.metrics?.gauge(Metric.CONCURRENT_OPERATIONS, (await this.records.listActive()).length);
    await this._audit("register", stored, params.deviceId);
    this.events.emit(ReliabilityEventType.OPERATION_REGISTERED, { operationId: stored.operationId, mediaId: stored.mediaId, operationType: stored.operationType, totalChunks: total, bytesTotal });
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
    this.metrics?.recordProgress({ pendingChunks: checkpoint.pendingChunks });

    record = await this.records.update(params.operationId, { checkpoint, lastActivityAt: new Date(now).toISOString(), version: (record.version ?? 0) + 1 });
    const health = scoreHealth(record, { now });
    record = await this._applyHealth(record, health, now);
    if ((checkpoint.pendingChunks ?? 0) >= this.backlogThreshold) this.events.emit(ReliabilityEventType.BACKLOG_DETECTED, { operationId: record.operationId, mediaId: record.mediaId, backlog: checkpoint.pendingChunks });
    this.events.emit(ReliabilityEventType.CHECKPOINT_RECORDED, { operationId: record.operationId, completedChunks: checkpoint.completedChunks, cursor: checkpoint.cursor, progress: health.progress });
    return record;
  }

  /** Mark a media operation completed (success). */
  async complete(operationId, options = {}) {
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (record.state === ReliabilityState.COMPLETED) return record;
    record = await this._transition(record, ReliabilityState.COMPLETED, { reason: "completed", patch: { lastActivityAt: this._nowIso() } });
    const latency = this.clock() - new Date(record.registeredAt).getTime();
    const bytes = record.checkpoint?.bytesTransferred ?? record.checkpoint?.bytesTotal ?? 0;
    this.metrics?.recordOperation(true);
    if (record.operationType === MediaOperationType.UPLOAD) this.metrics?.recordUpload(true, latency, bytes);
    else if (record.operationType === MediaOperationType.DOWNLOAD) this.metrics?.recordDownload(true, latency, bytes);
    else if (record.operationType === MediaOperationType.STREAMING) this.metrics?.recordStreaming(latency, bytes);
    else if (record.operationType === MediaOperationType.SYNCHRONIZATION) this.metrics?.recordSyncLatency(latency);
    this.metrics?.gauge(Metric.CONCURRENT_OPERATIONS, (await this.records.listActive()).length);
    await this._audit("complete", record, options.actingDevice);
    this.events.emit(ReliabilityEventType.OPERATION_COMPLETED, { operationId: record.operationId, mediaId: record.mediaId, operationType: record.operationType, latencyMs: latency });
    return record;
  }

  // === interruption + recovery =============================================

  /** Flag a media operation as interrupted (optionally auto-recover). */
  async reportInterruption(operationId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(operationId);
    if (isTerminalReliabilityState(record.state)) return record;
    if (trigger === "storage-failure") this.metrics?.recordStorageError();
    const now = options.now ?? this.clock();
    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: record.metadata?.recoveringSince ?? new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.OPERATION_INTERRUPTED,
        eventPayload: { trigger, mediaId: record.mediaId },
      });
    }
    if (options.autoRecover) return this.recover(operationId, trigger, { ...options, now });
    return record;
  }

  /**
   * Run a recovery for an interrupted (or degraded) media operation. Resolves the action for the trigger,
   * enforces bounded attempts + a retry budget + a recovery timeout, and always PRESERVES the checkpoint
   * (integrity + metadata consistency). @returns {Promise<{ outcome, record, resumePlan }>}
   */
  async recover(operationId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new MediaReliabilityError(`Cannot recover a ${record.state} operation`, { code: "ERR_MEDIAREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const policy = resolveRetryPolicy(record.retryPolicy ?? this.retryPolicy);

    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.OPERATION_INTERRUPTED,
        eventPayload: { trigger, mediaId: record.mediaId },
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
    if (failed.operationType === MediaOperationType.UPLOAD) this.metrics?.recordUpload(false);
    else if (failed.operationType === MediaOperationType.DOWNLOAD) this.metrics?.recordDownload(false);
    await this._audit("graceful-fail", failed, actingDevice, reason);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { operationId: record.operationId, reason });
    this.events.emit(ReliabilityEventType.OPERATION_FAILED, { operationId: record.operationId, mediaId: record.mediaId, reason });
    await this.recoveryHistory?.record({ operationId: record.operationId, outcome: RecoveryOutcome.EXHAUSTED, action: RecoveryAction.GRACEFUL_FAIL, at: this._nowIso() });
    return { outcome: RecoveryOutcome.EXHAUSTED, record: failed, resumePlan: null };
  }

  /** Explicitly resume a media operation from its checkpoint (manual retry / automatic resume). */
  async resume(operationId, options = {}) {
    let record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new MediaReliabilityError(`Cannot resume a ${record.state} operation`, { code: "ERR_MEDIAREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const plan = planResume(record.checkpoint, { now });
    const ok = await this._callHook(this.recoveryHooks.resumeFromCheckpoint, record, plan);
    if (record.state !== ReliabilityState.TRACKING) record = await this._transition(record, ReliabilityState.TRACKING, { reason: "resumed", patch: { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() } });
    else record = await this.records.update(operationId, { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() });
    this.metrics?.recordResume();
    this.events.emit(ReliabilityEventType.OPERATION_RESUMED, { operationId, resumePlan: plan });
    return { resumePlan: plan, resumed: ok, record };
  }

  /** Abandon (cancel) a tracked media operation. */
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

  /** Aggregate reliability health for a whole MEDIA object (all its operations). */
  async getMediaHealth(mediaId) {
    validateRef(mediaId, "media identifier");
    const records = await this.records.listByMedia(mediaId);
    return { mediaId: String(mediaId), ...scoreMediaHealth(records, { now: this.clock() }) };
  }

  async getDiagnostics(operationId, options = {}) {
    const record = await this._require(operationId);
    if (options.actingDevice) this._assertOwner(record, options.actingDevice);
    const recoveryHistory = this.recoveryHistory ? await this.recoveryHistory.listByOperation(operationId, { limit: 20 }) : [];
    return buildDiagnostics({ record, recoveryHistory, now: this.clock() });
  }

  async listOperations(options = {}) {
    if (options.mediaId) return this.records.listByMedia(options.mediaId, { state: options.state, limit: options.limit });
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
      framework: "media-reliability",
      states: counts,
      activeOperations: active.length,
      operationSuccessRate: this.metrics?.operationSuccessRate?.() ?? null,
      uploadSuccessRate: this.metrics?.uploadSuccessRate?.() ?? null,
      downloadSuccessRate: this.metrics?.downloadSuccessRate?.() ?? null,
      recoverySuccessRate: this.metrics?.recoverySuccessRate?.() ?? null,
      cacheHitRate: this.metrics?.cacheHitRate?.() ?? null,
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
    if (prevStatus !== health.status) this.events.emit(ReliabilityEventType.HEALTH_CHANGED, { operationId: record.operationId, mediaId: record.mediaId, status: health.status, score: health.score, failureRate: health.failureRate });
    return next;
  }

  async _require(operationId) {
    validateRef(operationId, "operation identifier");
    return requireRecord(await this.records.findById(String(operationId)), operationId);
  }

  _assertOwner(record, actingDevice) {
    const id = String(actingDevice);
    if (id !== String(record.deviceId) && id !== String(record.userId)) {
      throw new MediaReliabilityError("Caller does not own this media operation", { code: "ERR_MEDIAREL_FORBIDDEN", status: 403, reason: ReliabilityFailureReason.UNAUTHORIZED });
    }
  }

  async _transition(record, toState, options = {}) {
    assertTransition(record.state, toState);
    const patch = { state: toState, version: (record.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoContent(patch, "reliability record");
    const updated = await this.records.update(record.operationId, patch);
    this.events.emit(ReliabilityEventType.STATE_CHANGED, { operationId: updated.operationId, from: record.state, to: toState, reason: options.reason });
    if (options.event) this.events.emit(options.event, { operationId: updated.operationId, ...(options.eventPayload ?? {}) });
    return updated;
  }

  /** @private record an audit entry for a media operation (append-only; no content/keys). */
  async _audit(operation, record, actingDevice, outcome = "ok") {
    if (!this.audit?.record) return;
    try {
      await this.audit.record(auditOperation({ operation, operationId: record.operationId, mediaId: record.mediaId, actingDevice: actingDevice != null ? String(actingDevice) : null, outcome, at: this._nowIso() }));
    } catch {
      /* audit persistence failure must never break the media path */
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

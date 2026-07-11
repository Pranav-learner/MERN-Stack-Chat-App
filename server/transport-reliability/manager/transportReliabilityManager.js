/**
 * @module transport-reliability/manager
 *
 * The **Transport Reliability Manager** — the orchestrator that makes the Data Plane production-grade.
 * It tracks a reliability record per transfer, advances a monotonic resume CHECKPOINT from Transport-
 * Engine progress, continuously scores health, and drives RECOVERY (resume-from-checkpoint / retry /
 * migrate / graceful-fail) + CONNECTION MIGRATION (WiFi ↔ mobile, connection replacement) through
 * injected hooks — all while preserving transfer state so recovery never corrupts a transfer.
 *
 * @security Operates on CONTROL-PLANE metadata + numeric aggregates ONLY — transfer/chunk counts,
 * byte totals, states, health scores. It NEVER handles payload bytes or keys; the no-plaintext deep
 * scan is enforced before every persist.
 *
 * @evolution Transport-INDEPENDENT: recovery + migration call INJECTED hooks (the device / Layer-7
 * Connection Manager perform the real work + confirm via a subsequent checkpoint). Layer 9 (offline
 * sync) consumes the frozen interfaces + the checkpoint/resume seam.
 *
 * @example
 * ```js
 * const mgr = new TransportReliabilityManager({ ...createInMemoryReliabilityRepository(), recoveryHooks });
 * await mgr.registerTransfer({ transferId, conversationId, senderDeviceId, receiverDeviceId, connectionId, totalChunks });
 * await mgr.checkpoint({ transferId, chunksAcked: 40, highWaterMark: 39, bytesTransferred: 2_600_000, outstanding: 4 });
 * await mgr.recover(transferId, "connection-loss", { newConnectionId: "conn-2" }); // migrate + resume
 * ```
 */

import {
  ReliabilityState,
  RecoveryOutcome,
  MigrationOutcome,
  MigrationTrigger,
  RecoveryAction,
  RecoveryTrigger,
  ReliabilityEventType,
  ReliabilityFailureReason,
  HealthStatus,
  Metric,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TRANSFER_TTL_MS,
  isTerminalReliabilityState,
} from "../types/types.js";
import { ReliabilityError, RecoveryExhaustedError, MigrationRejectedError } from "../errors.js";
import { assertTransition } from "./transferReliabilityLifecycle.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { ConnectionMigrator } from "../migration/connectionMigrator.js";
import { planResume, advanceCheckpoint } from "../resume/resumePlanner.js";
import { scoreHealth } from "../monitoring/healthMonitor.js";
import { buildDiagnostics } from "../diagnostics/diagnostics.js";
import { ReliabilityEventBus } from "../events/events.js";
import {
  validateRegisterRequest,
  validateCheckpointUpdate,
  validateRecoveryTrigger,
  validateMigrationTrigger,
  validateRef,
  requireRecord,
  assertNoPlaintext,
  validateRepository,
} from "../validators/validators.js";

const DEFAULT_TTL_MS = DEFAULT_TRANSFER_TTL_MS ?? 6 * 60 * 60 * 1000;

export class TransportReliabilityManager {
  constructor(deps = {}) {
    validateRepository({ records: deps.records });
    this.records = deps.records;
    this.recoveryHistory = deps.recoveryHistory ?? null;
    this.migrationHistory = deps.migrationHistory ?? null;
    this.events = deps.events ?? new ReliabilityEventBus();
    this.metrics = deps.metrics ?? null;
    this.monitor = deps.monitor ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(deps.retryPolicy ?? {}) };
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.recoveryHooks = deps.recoveryHooks ?? {};
    this.migrationHooks = deps.migrationHooks ?? {};
    this.coordinator = deps.coordinator ?? new RecoveryCoordinator({ retryPolicy: this.retryPolicy, clock: this.clock });
    this.migrator = deps.migrator ?? new ConnectionMigrator({ clock: this.clock });
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === registration + checkpointing ========================================

  /**
   * Register a transfer for reliability tracking. @returns {Promise<object>} the record
   * @param {{ transferId, conversationId, senderDeviceId, receiverDeviceId, connectionId?, totalChunks, priority?, retryPolicy?, metadata? }} params
   */
  async registerTransfer(params) {
    validateRegisterRequest(params);
    const existing = await this.records.findById(params.transferId);
    if (existing) return existing; // idempotent
    const now = this.clock();
    const record = {
      transferId: String(params.transferId),
      conversationId: String(params.conversationId),
      senderDeviceId: String(params.senderDeviceId),
      receiverDeviceId: String(params.receiverDeviceId),
      connectionId: params.connectionId ?? null,
      state: ReliabilityState.TRACKING,
      priority: params.priority ?? "file",
      checkpoint: { totalChunks: params.totalChunks, chunksAcked: 0, bytesTransferred: 0, highWaterMark: -1, outstanding: 0, retryCount: 0, checkpointAt: this._nowIso() },
      health: { status: HealthStatus.HEALTHY, score: 1, throughputBytesPerSec: 0, retryRate: 0, failureRate: 0, outstanding: 0, stalenessMs: 0, progress: 0 },
      recoveryCount: 0,
      resumeCount: 0,
      migrationCount: 0,
      retryPolicy: { ...this.retryPolicy, ...(params.retryPolicy ?? {}) },
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
    this.metrics?.increment(Metric.TRANSFER_TOTAL);
    this.metrics?.gauge(Metric.CONCURRENT_TRANSFERS, (await this.records.listActive()).length);
    this.events.emit(ReliabilityEventType.TRANSFER_REGISTERED, { transferId: stored.transferId, conversationId: stored.conversationId, totalChunks: params.totalChunks });
    return stored;
  }

  /**
   * Record a progress checkpoint from the Transport Engine (monotonic — never regresses). Advances the
   * resume point, recomputes health, and toggles TRACKING ↔ DEGRADED. @returns {Promise<object>}
   * @param {{ transferId, chunksAcked?, bytesTransferred?, highWaterMark?, outstanding?, retryCount?, totalChunks?, missingIndices?, backpressure? }} params
   */
  async checkpoint(params) {
    validateRef(params.transferId, "transfer identifier");
    validateCheckpointUpdate(params);
    let record = await this._require(params.transferId);
    if (isTerminalReliabilityState(record.state)) return record; // ignore late checkpoints
    const now = this.clock();
    const checkpoint = advanceCheckpoint(record.checkpoint, params, { now });
    const patch = { checkpoint, lastActivityAt: new Date(now).toISOString() };

    // Metrics: throughput + chunk size + outstanding.
    const elapsedSec = Math.max(0.001, (now - new Date(record.registeredAt).getTime()) / 1000);
    this.metrics?.recordThroughput(checkpoint.bytesTransferred / elapsedSec, checkpoint.totalChunks ? checkpoint.bytesTransferred / Math.max(1, checkpoint.chunksAcked) : undefined);
    this.metrics?.gauge(Metric.OUTSTANDING_CHUNKS, checkpoint.outstanding ?? 0);
    if (params.backpressure) this.metrics?.increment(Metric.BACKPRESSURE_TOTAL);

    record = await this.records.update(params.transferId, { ...patch, version: (record.version ?? 0) + 1 });
    const health = this._recomputeHealth(record, now);
    record = await this._applyHealth(record, health, now);
    this.events.emit(ReliabilityEventType.CHECKPOINT_RECORDED, { transferId: record.transferId, chunksAcked: checkpoint.chunksAcked, highWaterMark: checkpoint.highWaterMark, progress: health.progress });
    return record;
  }

  /** Mark a transfer completed (success). */
  async complete(transferId, options = {}) {
    let record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    if (record.state === ReliabilityState.COMPLETED) return record;
    record = await this._transition(record, ReliabilityState.COMPLETED, { reason: "completed", patch: { lastActivityAt: this._nowIso() } });
    const latency = this.clock() - new Date(record.registeredAt).getTime();
    this.metrics?.recordTransfer(true, latency);
    this.metrics?.gauge(Metric.CONCURRENT_TRANSFERS, (await this.records.listActive()).length);
    this.events.emit(ReliabilityEventType.TRANSFER_COMPLETED, { transferId: record.transferId, conversationId: record.conversationId, latencyMs: latency });
    return record;
  }

  // === interruption + recovery =============================================

  /** Flag a transfer as interrupted (does not auto-recover unless `options.autoRecover`). */
  async reportInterruption(transferId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(transferId);
    if (isTerminalReliabilityState(record.state)) return record;
    const now = options.now ?? this.clock();
    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: record.metadata?.recoveringSince ?? new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.TRANSFER_INTERRUPTED,
        eventPayload: { trigger },
      });
    }
    if (options.autoRecover) return this.recover(transferId, trigger, { ...options, now });
    return record;
  }

  /**
   * Run a recovery for an interrupted (or degraded) transfer. Resolves the action for the trigger,
   * enforces bounded attempts + a recovery timeout, executes it via hooks, and always PRESERVES the
   * checkpoint. @returns {Promise<{ outcome: string, record: object, resumePlan: object|null }>}
   * @param {string} transferId @param {string} trigger @param {{ actingDevice?, newConnectionId?, now?: number }} [options]
   */
  async recover(transferId, trigger, options = {}) {
    validateRecoveryTrigger(trigger);
    let record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new ReliabilityError(`Cannot recover a ${record.state} transfer`, { code: "ERR_TRANSREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();

    // Ensure INTERRUPTED (records recoveringSince) before recovering.
    if (record.state !== ReliabilityState.INTERRUPTED && record.state !== ReliabilityState.RECOVERING) {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, {
        reason: trigger,
        patch: { metadata: { ...(record.metadata ?? {}), recoveringSince: new Date(now).toISOString(), lastTrigger: trigger } },
        event: ReliabilityEventType.TRANSFER_INTERRUPTED,
        eventPayload: { trigger },
      });
    }

    const recoveringSince = new Date(record.metadata?.recoveringSince ?? new Date(now).toISOString()).getTime();
    const attempt = (record.recoveryCount ?? 0) + 1;
    const { action, recoverable } = this.coordinator.resolvePlan(trigger);

    // Unrecoverable trigger, timed out, or attempts exhausted → graceful failure (state preserved).
    if (!recoverable) return this._gracefulFail(record, ReliabilityFailureReason.UNRECOVERABLE, now, recoveringSince);
    if (now - recoveringSince > this.retryPolicy.recoveryTimeoutMs) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince);
    if (!this.coordinator.shouldRetry(attempt - 1)) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince);

    record = await this._transition(record, ReliabilityState.RECOVERING, { patch: { recoveryCount: attempt }, event: ReliabilityEventType.RECOVERY_STARTED, eventPayload: { trigger, attempt, action } });
    this.metrics?.increment(Metric.RECOVERY_TOTAL);

    // A connection-loss / network-change resolves to migration when a new connection is available.
    const target = options.newConnectionId ?? record.metadata?.pendingConnectionId ?? null;
    let result;
    if (action === RecoveryAction.MIGRATE && target) {
      const migrated = await this._migrateInternal(record, target, this._migrationTriggerFor(trigger), now);
      record = migrated.record;
      result = { outcome: migrated.result.outcome === MigrationOutcome.MIGRATED ? RecoveryOutcome.MIGRATED : RecoveryOutcome.FAILED, action, resumePlan: planResume(record.checkpoint, { now }) };
    } else {
      result = await this.coordinator.run({ record, trigger, attempt, hooks: this.recoveryHooks, newConnectionId: target });
    }

    return this._applyRecoveryOutcome(record, trigger, result, now, recoveringSince);
  }

  /** @private apply a coordinator/migration recovery result → success or (bounded) failure. */
  async _applyRecoveryOutcome(record, trigger, result, now, recoveringSince) {
    const recoveryTimeMs = now - recoveringSince;
    if (result.outcome === RecoveryOutcome.RECOVERED || result.outcome === RecoveryOutcome.MIGRATED) {
      const patch = { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso(), metadata: { ...(record.metadata ?? {}), recoveringSince: null } };
      // A migration already transitioned to TRACKING; a resume/retry transitions here.
      if (record.state === ReliabilityState.RECOVERING) record = await this._transition(record, ReliabilityState.TRACKING, { reason: result.action, patch });
      else record = await this.records.update(record.transferId, { ...patch, version: (record.version ?? 0) + 1 });
      this.metrics?.recordRecovery(true, recoveryTimeMs);
      this.metrics?.recordResume();
      this.events.emit(ReliabilityEventType.RESUME_PLANNED, { transferId: record.transferId, resumePlan: result.resumePlan });
      this.events.emit(ReliabilityEventType.RECOVERY_SUCCEEDED, { transferId: record.transferId, action: result.action, recoveryTimeMs });
      await this.recoveryHistory?.record({ transferId: record.transferId, kind: "recovery", trigger, action: result.action, outcome: result.outcome, attempt: record.recoveryCount, at: this._nowIso() });
      return { outcome: result.outcome, record, resumePlan: result.resumePlan ?? null };
    }

    // Attempt failed. Exhausted → graceful fail; else drop back to INTERRUPTED for a later retry.
    this.metrics?.recordRecovery(false, recoveryTimeMs);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { transferId: record.transferId, action: result.action, attempt: record.recoveryCount });
    await this.recoveryHistory?.record({ transferId: record.transferId, kind: "recovery", trigger, action: result.action, outcome: result.outcome, attempt: record.recoveryCount, at: this._nowIso() });
    if (!this.coordinator.shouldRetry(record.recoveryCount)) return this._gracefulFail(record, ReliabilityFailureReason.RECOVERY_EXHAUSTED, now, recoveringSince);
    record = await this._transition(record, ReliabilityState.INTERRUPTED, { reason: "recovery-attempt-failed" });
    return { outcome: RecoveryOutcome.FAILED, record, resumePlan: result.resumePlan ?? null };
  }

  /** @private graceful failure — terminal FAILED with the checkpoint intact (resumable later). */
  async _gracefulFail(record, reason, now, recoveringSince) {
    const failed = await this._transition(record, ReliabilityState.FAILED, { reason, patch: { failureReason: reason } });
    this.metrics?.recordRecovery(false, now - (recoveringSince ?? now));
    this.metrics?.recordTransfer(false);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { transferId: record.transferId, reason });
    this.events.emit(ReliabilityEventType.TRANSFER_FAILED, { transferId: record.transferId, reason });
    await this.recoveryHistory?.record({ transferId: record.transferId, kind: "recovery", outcome: RecoveryOutcome.EXHAUSTED, action: RecoveryAction.GRACEFUL_FAIL, at: this._nowIso() });
    return { outcome: RecoveryOutcome.EXHAUSTED, record: failed, resumePlan: null };
  }

  // === resume + migration ==================================================

  /** Explicitly resume a transfer from its checkpoint (re-send only the missing chunks). */
  async resume(transferId, options = {}) {
    let record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new ReliabilityError(`Cannot resume a ${record.state} transfer`, { code: "ERR_TRANSREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const plan = planResume(record.checkpoint, { now });
    const ok = await this._callHook(this.recoveryHooks.resumeFromCheckpoint, record, plan);
    if (record.state !== ReliabilityState.TRACKING) record = await this._transition(record, ReliabilityState.TRACKING, { reason: "resumed", patch: { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() } });
    else record = await this.records.update(transferId, { resumeCount: (record.resumeCount ?? 0) + 1, lastActivityAt: this._nowIso() });
    this.metrics?.recordResume();
    this.events.emit(ReliabilityEventType.RESUME_PLANNED, { transferId, resumePlan: plan });
    return { resumePlan: plan, resumed: ok, record };
  }

  /** Migrate a transfer onto a new Active Connection. */
  async migrate(transferId, newConnectionId, options = {}) {
    validateRef(newConnectionId, "connection identifier");
    validateMigrationTrigger(options.trigger);
    let record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) throw new ReliabilityError(`Cannot migrate a ${record.state} transfer`, { code: "ERR_TRANSREL_INVALID_TRANSITION", status: 409 });
    const now = options.now ?? this.clock();
    const { result, record: updated } = await this._migrateInternal(record, newConnectionId, options.trigger ?? MigrationTrigger.MANUAL, now);
    if (result.outcome !== MigrationOutcome.MIGRATED) {
      throw new MigrationRejectedError(`Migration ${result.outcome}: ${result.reason ?? ""}`.trim(), { reason: result.reason, details: { transferId, newConnectionId } });
    }
    return updated;
  }

  /** @private core migration used by both recover() + migrate(). */
  async _migrateInternal(record, newConnectionId, trigger, now) {
    this.metrics?.increment(Metric.MIGRATION_TOTAL);
    record = await this._transition(record, ReliabilityState.MIGRATING, { reason: trigger, event: ReliabilityEventType.MIGRATION_STARTED, eventPayload: { trigger, newConnectionId } });
    const result = await this.migrator.migrate({ record, newConnectionId, trigger, hooks: this.migrationHooks });
    if (result.outcome === MigrationOutcome.MIGRATED) {
      record = await this._transition(record, ReliabilityState.TRACKING, { reason: "migrated", patch: { connectionId: result.connectionId, migrationCount: (record.migrationCount ?? 0) + 1, lastActivityAt: this._nowIso() } });
      this.metrics?.recordMigration(true);
      this.events.emit(ReliabilityEventType.MIGRATION_SUCCEEDED, { transferId: record.transferId, from: result.previousConnectionId, to: result.connectionId, trigger });
    } else {
      record = await this._transition(record, ReliabilityState.INTERRUPTED, { reason: result.reason ?? "migration-failed" });
      this.metrics?.recordMigration(false);
      this.events.emit(ReliabilityEventType.MIGRATION_FAILED, { transferId: record.transferId, reason: result.reason, trigger });
    }
    await this.migrationHistory?.record({ transferId: record.transferId, kind: "migration", trigger, outcome: result.outcome, fromConnectionId: result.previousConnectionId, toConnectionId: result.outcome === MigrationOutcome.MIGRATED ? result.connectionId : null, at: this._nowIso() });
    return { result, record };
  }

  /** Abandon (cancel) a tracked transfer. */
  async abandon(transferId, options = {}) {
    let record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    if (isTerminalReliabilityState(record.state)) return record;
    record = await this._transition(record, ReliabilityState.ABANDONED, { reason: options.reason ?? "abandoned", patch: { failureReason: "abandoned" } });
    this.events.emit(ReliabilityEventType.TRANSFER_FAILED, { transferId, reason: "abandoned" });
    return record;
  }

  // === queries =============================================================

  async getRecord(transferId, options = {}) {
    const record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    return record;
  }

  /** A transfer's live health (recomputed now). */
  async getHealth(transferId) {
    const record = await this._require(transferId);
    return scoreHealth(record, { now: this.clock() });
  }

  /** A transfer's full diagnostics (health + checkpoint + resume plan + histories). */
  async getDiagnostics(transferId, options = {}) {
    const record = await this._require(transferId);
    if (options.actingDevice) this._assertParticipant(record, options.actingDevice);
    const recoveryHistory = this.recoveryHistory ? await this.recoveryHistory.listByTransfer(transferId, { limit: 20 }) : [];
    const migrationHistory = this.migrationHistory ? await this.migrationHistory.listByTransfer(transferId, { limit: 20 }) : [];
    return buildDiagnostics({ record, recoveryHistory, migrationHistory, now: this.clock() });
  }

  /** List a device's transfers (optionally by state). */
  async listTransfers(options = {}) {
    if (options.deviceId) return this.records.listByParticipant(options.deviceId, { state: options.state, limit: options.limit });
    return this.records.listActive();
  }

  /** Stalled transfers (used by the health monitor's sweep). */
  async listStalled(now, timeoutMs) {
    return this.records.listStalled(now ?? this.clock(), timeoutMs ?? this.stallTimeoutMs);
  }

  /** Aggregate control-plane health snapshot. */
  async health() {
    const counts = await this.records.countByState();
    const active = await this.records.listActive();
    return {
      framework: "transport-reliability",
      states: counts,
      activeTransfers: active.length,
      transferSuccessRate: this.metrics?.transferSuccessRate?.() ?? null,
      recoverySuccessRate: this.metrics?.recoverySuccessRate?.() ?? null,
      at: this._nowIso(),
    };
  }

  // === internals ==========================================================

  _recomputeHealth(record, now) {
    return scoreHealth(record, { now });
  }

  async _applyHealth(record, health, now) {
    const prevStatus = record.health?.status;
    let next = record;
    // Toggle TRACKING ↔ DEGRADED from health, leaving other states untouched.
    if (health.status === HealthStatus.HEALTHY && record.state === ReliabilityState.DEGRADED) {
      next = await this._transition(record, ReliabilityState.TRACKING, { reason: "health-recovered", patch: { health } });
    } else if (health.status !== HealthStatus.HEALTHY && record.state === ReliabilityState.TRACKING) {
      next = await this._transition(record, ReliabilityState.DEGRADED, { reason: "health-degraded", patch: { health } });
    } else {
      next = await this.records.update(record.transferId, { health, version: (record.version ?? 0) + 1 });
    }
    this.metrics?.gauge(Metric.HEALTH_SCORE, health.score);
    if (prevStatus !== health.status) this.events.emit(ReliabilityEventType.HEALTH_CHANGED, { transferId: record.transferId, status: health.status, score: health.score });
    return next;
  }

  async _require(transferId) {
    validateRef(transferId, "transfer identifier");
    return requireRecord(await this.records.findById(String(transferId)), transferId);
  }

  _assertParticipant(record, actingDevice) {
    const id = String(actingDevice);
    if (id !== String(record.senderDeviceId) && id !== String(record.receiverDeviceId)) {
      throw new ReliabilityError("Caller is not a participant in this transfer", { code: "ERR_TRANSREL_FORBIDDEN", status: 403, reason: ReliabilityFailureReason.UNAUTHORIZED });
    }
  }

  async _transition(record, toState, options = {}) {
    assertTransition(record.state, toState);
    const patch = { state: toState, version: (record.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "reliability record");
    const updated = await this.records.update(record.transferId, patch);
    this.events.emit(ReliabilityEventType.STATE_CHANGED, { transferId: updated.transferId, from: record.state, to: toState, reason: options.reason });
    if (options.event) this.events.emit(options.event, { transferId: updated.transferId, ...(options.eventPayload ?? {}) });
    return updated;
  }

  /** @private map a recovery trigger to the migration trigger it implies. */
  _migrationTriggerFor(recoveryTrigger) {
    if (recoveryTrigger === RecoveryTrigger.NETWORK_CHANGE) return MigrationTrigger.CONNECTION_REPLACED;
    if (recoveryTrigger === RecoveryTrigger.CONNECTION_LOSS) return MigrationTrigger.CONNECTION_LOST;
    return MigrationTrigger.CONNECTION_REPLACED;
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

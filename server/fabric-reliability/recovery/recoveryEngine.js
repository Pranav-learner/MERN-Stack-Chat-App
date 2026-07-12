/**
 * @module fabric-reliability/recovery/recoveryEngine
 *
 * The **Recovery Engine** (STEP 3) — makes interrupted fabric operations recoverable. It writes a
 * checkpoint before an operation runs, and on failure it drives the per-stage recovery strategy: RESUME
 * (re-run from checkpoint), REPLAN (defer), or GRACEFULLY FAIL (degrade cleanly). Recovery is bounded by a
 * recovery timeout + a max-resume-attempts cap, and it PRESERVES EXECUTION CONSISTENCY — an operation
 * either resumes to success or is recorded as gracefully failed / abandoned; it never partially applies.
 *
 * `recoverInterrupted()` is the sweep (the stall-monitor): after a crash / restart it finds operations
 * still marked RUNNING past the stall threshold and recovers or abandons them, so no operation is left
 * dangling.
 *
 * @security Reasons over checkpoint stage markers + ids + classifications only. No content.
 */

import { createCheckpoint, patchCheckpoint } from "./checkpoint.js";
import { createDefaultRecoveryStrategies, defaultRecoveryStrategy } from "./recoveryStrategies.js";
import { GracefulDegradation } from "./degradation.js";
import { withTimeout } from "../timeout/timeout.js";
import { OperationState, RecoveryOutcome, DEFAULT_RECOVERY, ReliabilityEventType } from "../types/types.js";

export class RecoveryEngine {
  /**
   * @param {object} deps
   * @param {object} deps.operations the operations store (`upsert · findById · listActive · delete`)
   * @param {Map<string, object>} [deps.strategies] @param {GracefulDegradation} [deps.degradation]
   * @param {import("../events/events.js").FabricReliabilityEventBus} [deps.events] @param {object} [deps.config]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.store = deps.operations;
    this.strategies = deps.strategies ?? createDefaultRecoveryStrategies();
    this.degradation = deps.degradation ?? new GracefulDegradation({ events: deps.events });
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.config = { ...DEFAULT_RECOVERY, ...(deps.config ?? {}) };
    this._stats = { begun: 0, completed: 0, recoveries: 0, resumed: 0, replanned: 0, gracefulFailed: 0, abandoned: 0 };
  }

  _iso() {
    return new Date(this.clock()).toISOString();
  }

  /** Begin tracking an operation (write its RUNNING checkpoint). */
  async begin(operationId, kind, data = {}) {
    this._stats.begun++;
    const checkpoint = createCheckpoint({ operationId, kind, data, at: this._iso() });
    if (this.store) await this.store.upsert(checkpoint);
    return checkpoint;
  }

  /** Update an operation's checkpoint (stage/attempt/data). */
  async touch(operationId, patch = {}) {
    if (!this.store) return null;
    const existing = await this.store.findById(operationId);
    if (!existing) return null;
    const updated = patchCheckpoint(existing, patch, this._iso());
    await this.store.upsert(updated);
    return updated;
  }

  /** Mark an operation successfully completed. */
  async complete(operationId) {
    this._stats.completed++;
    await this.touch(operationId, { state: OperationState.SUCCEEDED });
  }

  /**
   * Recover a failed operation.
   * @param {string} operationId @param {Error} error
   * @param {object} ctx `{ kind, failureClass, executor, checkpoint }`
   * @returns {Promise<{ ok: boolean, outcome: string, result?: any, degraded?: object }>}
   */
  async recover(operationId, error, ctx = {}) {
    this._stats.recoveries++;
    this.events?.emit(ReliabilityEventType.RECOVERY_STARTED, { operationId, kind: ctx.kind, failureClass: ctx.failureClass });
    const checkpoint = ctx.checkpoint ?? (this.store ? await this.store.findById(operationId) : null) ?? createCheckpoint({ operationId, kind: ctx.kind, at: this._iso() });
    await this.touch(operationId, { state: OperationState.RECOVERING });

    const strategy = this.strategies.get(ctx.kind) ?? defaultRecoveryStrategy;

    // non-resumable (caller error / permanent) → graceful failure
    if (!ctx.executor || !strategy.canResume(checkpoint, ctx.failureClass)) {
      return this._gracefulFail(operationId, ctx.kind, error, RecoveryOutcome.GRACEFULLY_FAILED);
    }

    // bounded resume attempts within the recovery timeout
    let lastError = error;
    for (let attempt = 1; attempt <= this.config.maxResumeAttempts; attempt++) {
      try {
        const out = await withTimeout(() => strategy.resume(checkpoint, ctx.executor, { failureClass: ctx.failureClass }), this.config.recoveryTimeoutMs, { label: `recover:${ctx.kind}` });
        const outcome = out.outcome ?? RecoveryOutcome.RESUMED;
        if (outcome === RecoveryOutcome.RESUMED) this._stats.resumed++;
        else if (outcome === RecoveryOutcome.REPLANNED) this._stats.replanned++;
        await this.touch(operationId, { state: OperationState.RECOVERED, attempt: (checkpoint.attempt ?? 1) + attempt });
        this.events?.emit(ReliabilityEventType.RECOVERY_COMPLETED, { operationId, kind: ctx.kind, outcome });
        return { ok: true, outcome, result: out.result };
      } catch (e) {
        lastError = e;
      }
    }
    // exhausted → abandon (graceful)
    return this._gracefulFail(operationId, ctx.kind, lastError, RecoveryOutcome.ABANDONED);
  }

  /** The stall sweep — recover / abandon operations left RUNNING past the stall threshold. */
  async recoverInterrupted({ executorResolver } = {}) {
    if (!this.store) return { scanned: 0, recovered: 0, abandoned: 0 };
    const now = this.clock();
    const active = await this.store.listActive();
    let recovered = 0;
    let abandoned = 0;
    for (const cp of active) {
      const age = now - new Date(cp.updatedAt ?? cp.startedAt).getTime();
      if (age < this.config.stalledAfterMs) continue;
      const executor = executorResolver?.(cp) ?? null;
      if (executor) {
        const out = await this.recover(cp.operationId, new Error("stalled"), { kind: cp.kind, failureClass: "transient", executor, checkpoint: cp });
        if (out.ok) recovered++;
        else abandoned++;
      } else {
        await this._gracefulFail(cp.operationId, cp.kind, new Error("stalled — no executor to resume"), RecoveryOutcome.ABANDONED);
        abandoned++;
      }
    }
    return { scanned: active.length, recovered, abandoned };
  }

  stats() {
    return { ...this._stats };
  }

  async _gracefulFail(operationId, kind, error, outcome) {
    if (outcome === RecoveryOutcome.ABANDONED) this._stats.abandoned++;
    else this._stats.gracefulFailed++;
    const degraded = this.degradation.degrade(kind, error, { operationId });
    await this.touch(operationId, { state: OperationState.GRACEFULLY_FAILED });
    this.events?.emit(ReliabilityEventType.RECOVERY_COMPLETED, { operationId, kind, outcome });
    return { ok: false, outcome, degraded };
  }
}

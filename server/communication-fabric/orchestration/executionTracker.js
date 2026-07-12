/**
 * @module communication-fabric/orchestration/executionTracker
 *
 * The **Execution Tracker** — the live, mutable record of one plan's execution. It holds the overall
 * {@link ExecutionStatus}, a per-step {@link StepStatus} ledger, timing, a bounded audit trail, and the
 * final outcome. The orchestrator drives it (start/step transitions/finish); the manager persists its
 * snapshot + returns a serialized view. Keeping tracking in one small object means the orchestrator's
 * control flow stays readable and every execution is fully inspectable for diagnostics (STEP 3).
 *
 * @security The audit trail records step ids + actions + statuses + error CODES — never content/keys.
 */

import { ExecutionStatus, StepStatus, MAX_AUDIT_ENTRIES } from "../types/types.js";

export class ExecutionTracker {
  /**
   * @param {object} spec
   * @param {string} spec.requestId @param {string} spec.planId @param {string} spec.decisionId
   * @param {string} spec.strategyType @param {object[]} spec.steps
   * @param {() => number} [spec.clock]
   */
  constructor(spec) {
    this.requestId = spec.requestId;
    this.planId = spec.planId;
    this.decisionId = spec.decisionId;
    this.strategyType = spec.strategyType;
    this.clock = spec.clock ?? (() => Date.now());
    this.status = ExecutionStatus.PLANNED;
    this.startedAt = null;
    this.finishedAt = null;
    /** @type {Map<string, object>} stepId → { status, subsystem, action, route, error, startedAt, finishedAt, viaFallback } */
    this.steps = new Map();
    for (const s of spec.steps) this.steps.set(s.stepId, { stepId: s.stepId, subsystem: s.subsystem, action: s.action, route: s.route, required: s.required, status: StepStatus.PENDING, error: null, startedAt: null, finishedAt: null, viaFallback: null });
    this.audit = [];
  }

  _log(event, extra = {}) {
    if (this.audit.length >= MAX_AUDIT_ENTRIES) this.audit.shift();
    this.audit.push({ event, at: new Date(this.clock()).toISOString(), ...extra });
  }

  start() {
    this.status = ExecutionStatus.EXECUTING;
    this.startedAt = new Date(this.clock()).toISOString();
    this._log("execution-started");
  }

  stepRunning(stepId) {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = StepStatus.RUNNING;
    s.startedAt = new Date(this.clock()).toISOString();
    this._log("step-started", { stepId, subsystem: s.subsystem, action: s.action });
  }

  stepSucceeded(stepId, { viaFallback } = {}) {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = viaFallback ? StepStatus.FELL_BACK : StepStatus.SUCCEEDED;
    s.viaFallback = viaFallback ?? null;
    s.finishedAt = new Date(this.clock()).toISOString();
    this._log("step-completed", { stepId, subsystem: s.subsystem, viaFallback: viaFallback ?? null });
  }

  stepFailed(stepId, errorInfo) {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = StepStatus.FAILED;
    s.error = errorInfo ?? null;
    s.finishedAt = new Date(this.clock()).toISOString();
    this._log("step-failed", { stepId, subsystem: s.subsystem, code: errorInfo?.code });
  }

  stepSkipped(stepId, reason) {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = StepStatus.SKIPPED;
    s.error = reason ? { reason } : null;
    s.finishedAt = new Date(this.clock()).toISOString();
    this._log("step-skipped", { stepId, reason });
  }

  /** Finalize: derive the overall status from the step ledger. */
  finish() {
    const all = [...this.steps.values()];
    const requiredFailed = all.some((s) => s.required && s.status === StepStatus.FAILED);
    const anySucceeded = all.some((s) => s.status === StepStatus.SUCCEEDED || s.status === StepStatus.FELL_BACK);
    const anyFailed = all.some((s) => s.status === StepStatus.FAILED);
    if (requiredFailed) this.status = ExecutionStatus.FAILED;
    else if (anyFailed && anySucceeded) this.status = ExecutionStatus.PARTIAL;
    else this.status = ExecutionStatus.COMPLETED;
    this.finishedAt = new Date(this.clock()).toISOString();
    this._log("execution-finished", { status: this.status });
    return this.status;
  }

  abort(reason) {
    this.status = ExecutionStatus.ABORTED;
    this.finishedAt = new Date(this.clock()).toISOString();
    this._log("execution-aborted", { reason });
    return this.status;
  }

  durationMs() {
    if (!this.startedAt || !this.finishedAt) return null;
    return new Date(this.finishedAt).getTime() - new Date(this.startedAt).getTime();
  }

  /** A serializable snapshot of the execution (the persisted + returned shape). */
  snapshot() {
    return {
      requestId: this.requestId,
      planId: this.planId,
      decisionId: this.decisionId,
      strategyType: this.strategyType,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs(),
      steps: [...this.steps.values()].map((s) => ({ ...s })),
      audit: [...this.audit],
    };
  }
}

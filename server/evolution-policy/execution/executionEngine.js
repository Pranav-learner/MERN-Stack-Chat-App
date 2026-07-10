/**
 * @module evolution-policy/execution
 *
 * The **rekey execution engine** — a reusable state machine that runs a single rekey
 * operation through its lifecycle and guarantees safety under concurrency:
 *
 * ```
 * pending ─▶ executing ─▶ completed
 *              │  ▲ (retry)
 *              ▼
 *            failed        pending/executing ─▶ cancelled (coalesced / cancelled)
 * ```
 *
 * Safety properties:
 * - **Serialized per session** — a promise-chain mutex ensures at most one execution runs
 *   for a session at a time (conflict resolution / no concurrent evolution).
 * - **Generation-based deduplication** — an execution carries the generation observed when
 *   its trigger fired; if the session has already advanced past it (a concurrent/duplicate
 *   rekey won the race), the execution is **coalesced** to `cancelled` instead of running,
 *   so a burst of identical triggers produces exactly one rekey.
 * - **Bounded retry** — a failing evolution retries up to `maxAttempts` before `failed`.
 *
 * The engine performs NO cryptography itself: it calls the injected `evolve` /
 * `currentGeneration` operations (the Sprint 2 forward-secrecy engine) and reports state.
 *
 * @security Execution records are metadata only. `evolve` failures never leave a session
 * partially rekeyed — the Sprint 2 engine's `evolve` is itself atomic.
 */

import crypto from "node:crypto";
import { ExecutionState, RekeyEventType, RekeyFailureReason, DEFAULT_MAX_ATTEMPTS } from "../types/types.js";

/**
 * @typedef {object} ExecutionOps The side-effecting operations an execution needs.
 * @property {() => Promise<number>} currentGeneration read the session's current generation
 * @property {() => Promise<object>} evolve perform ONE forward-secrecy evolution (returns the FS DTO)
 * @property {(execution: object) => Promise<void>|void} persist persist an execution-record snapshot
 */

export class RekeyExecutionEngine {
  /**
   * @param {object} deps
   * @param {import("../events/events.js").RekeyEventBus} deps.events
   * @param {() => number} [deps.clock] @param {number} [deps.maxAttempts]
   * @param {(scope: string, error: Error) => void} [deps.onError]
   */
  constructor(deps = {}) {
    this.events = deps.events;
    this.clock = deps.clock ?? (() => Date.now());
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._onError = deps.onError ?? (() => {});
    /** @type {Map<string, Promise<any>>} per-session mutex tails */
    this._locks = new Map();
  }

  /** Whether a session currently holds the execution lock (an execution is in flight). */
  isBusy(sessionId) {
    return this._locks.has(String(sessionId));
  }

  /**
   * Submit a rekey for execution. Serialized per session; deduplicated by generation.
   * @param {object} request `{ sessionId, trigger, policyId?, reason?, expectedGeneration? }`
   * @param {ExecutionOps} ops
   * @returns {Promise<{ execution: object, executed: boolean, coalesced?: boolean, generation?: number, error?: Error }>}
   */
  async submit(request, ops) {
    return this._exclusive(String(request.sessionId), () => this._run(request, ops));
  }

  // === internals ==========================================================

  /** @private Build a fresh PENDING execution record. */
  _newExecution(request) {
    return {
      executionId: crypto.randomUUID(),
      sessionId: String(request.sessionId),
      state: ExecutionState.PENDING,
      trigger: request.trigger,
      policyId: request.policyId,
      reason: request.reason,
      expectedGeneration: request.expectedGeneration ?? null,
      resultGeneration: null,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      error: null,
      createdAt: this._iso(),
    };
  }

  /** @private Drive one execution through the state machine. */
  async _run(request, ops) {
    const execution = this._newExecution(request);
    await ops.persist(execution);
    this._emit(RekeyEventType.REKEY_QUEUED, execution);

    // Generation-based dedup: has the session already advanced past what this trigger saw?
    const gen = await ops.currentGeneration();
    if (execution.expectedGeneration != null && gen !== execution.expectedGeneration) {
      execution.state = ExecutionState.CANCELLED;
      execution.reason = RekeyFailureReason.COALESCED;
      execution.completedAt = this._iso();
      await ops.persist(execution);
      this._emit(RekeyEventType.REKEY_CANCELLED, execution, { reason: RekeyFailureReason.COALESCED });
      return { execution, executed: false, coalesced: true };
    }

    execution.state = ExecutionState.EXECUTING;
    execution.startedAt = this._iso();
    await ops.persist(execution);
    this._emit(RekeyEventType.REKEY_STARTED, execution);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      execution.attempts = attempt;
      try {
        const result = await ops.evolve();
        execution.state = ExecutionState.COMPLETED;
        execution.resultGeneration = result?.currentGeneration ?? null;
        execution.completedAt = this._iso();
        await ops.persist(execution);
        this._emit(RekeyEventType.REKEY_COMPLETED, execution, { generation: execution.resultGeneration, previousGeneration: execution.expectedGeneration });
        return { execution, executed: true, generation: execution.resultGeneration, result };
      } catch (error) {
        execution.error = error?.code ?? "error";
        if (attempt < this.maxAttempts) {
          await ops.persist(execution);
          this._emit(RekeyEventType.REKEY_RETRY, execution, { reason: execution.error, details: { attempt } });
          continue;
        }
        execution.state = ExecutionState.FAILED;
        execution.failedAt = this._iso();
        await ops.persist(execution);
        this._emit(RekeyEventType.REKEY_FAILED, execution, { reason: execution.error });
        return { execution, executed: false, error };
      }
    }
    /* istanbul ignore next — loop always returns */
    return { execution, executed: false };
  }

  /** @private A promise-chain mutex: run `fn` after any in-flight op for the same session. */
  _exclusive(sessionId, fn) {
    const prev = this._locks.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Store a settle-swallowing tail; clean up when this run is the current tail.
    const tail = run.then(
      () => this._release(sessionId, tail),
      () => this._release(sessionId, tail),
    );
    this._locks.set(sessionId, tail);
    return run;
  }

  /** @private Remove the lock entry once its tail has settled (and is still current). */
  _release(sessionId, tail) {
    if (this._locks.get(sessionId) === tail) this._locks.delete(sessionId);
  }

  /** @private */
  _emit(type, execution, extra = {}) {
    if (!this.events) return;
    this.events.emit(type, {
      sessionId: execution.sessionId,
      executionId: execution.executionId,
      trigger: execution.trigger,
      policyId: execution.policyId,
      reason: execution.reason,
      ...extra,
    });
  }

  /** @private */
  _iso() {
    return new Date(this.clock()).toISOString();
  }
}

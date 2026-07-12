/**
 * @module group-reliability/recovery
 *
 * The **Recovery Engine** — decides HOW to recover an interrupted group operation and executes the
 * recovery via INJECTED hooks. It maps a trigger (interrupted-messaging / failed-fanout / rekey-failure
 * / membership-failure / replica-failure / sync-failure / offline-interruption / connection-loss /
 * stall) to an action (resume-from-checkpoint / retry / replan / graceful-fail), enforces bounded
 * attempts + a retry budget + a total recovery timeout, and always PRESERVES consistency by resuming
 * from the monotonic checkpoint.
 *
 * @important Recovery NEVER corrupts group state: it is a pure decision + a hook call; the checkpoint is
 * read, never mutated, and the manager applies state transitions atomically. On exhaustion the operation
 * fails GRACEFULLY with its checkpoint intact (a caller can resume later).
 *
 * @evolution Transport-INDEPENDENT: the actual re-run is the Sprint-2 engine's job (re-send failed
 * fan-out legs / re-distribute a rekey / resume a group sync), injected here as hooks. Defaults are
 * optimistic (the device/engine performs the work + confirms via a subsequent checkpoint).
 */

import { RECOVERY_PLANS, RecoveryAction, RecoveryOutcome, DEFAULT_RETRY_POLICY } from "../types/types.js";
import { resolveRetryPolicy, shouldRetry, withinBudget } from "../retry/retryPolicy.js";
import { planResume } from "./checkpoint.js";

export class RecoveryCoordinator {
  /** @param {{ retryPolicy?: object, clock?: () => number }} [deps] */
  constructor(deps = {}) {
    this.retryPolicy = resolveRetryPolicy(deps.retryPolicy ?? DEFAULT_RETRY_POLICY);
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** Resolve the recovery action + recoverability for a trigger. */
  resolvePlan(trigger) {
    return RECOVERY_PLANS[trigger] ?? { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true };
  }

  /**
   * Run ONE recovery attempt for a record. Returns a structured result the manager applies (it does NOT
   * persist or transition — that stays in the manager, so state changes are atomic).
   *
   * @param {object} params
   * @param {import("../types/types.js").GroupReliabilityRecord} params.record
   * @param {string} params.trigger @param {number} params.attempt (1-based)
   * @param {object} params.hooks `{ resumeFromCheckpoint, retry, replan, gracefulFail }` (async → boolean)
   * @returns {Promise<{ outcome: string, action: string, resumePlan: object|null, recoverable: boolean }>}
   */
  async run({ record, trigger, attempt, hooks = {} }) {
    const { action, recoverable } = this.resolvePlan(trigger);
    const policy = resolveRetryPolicy(record.retryPolicy ?? this.retryPolicy);
    if (!recoverable) {
      await safe(hooks.gracefulFail, record);
      return { outcome: RecoveryOutcome.FAILED, action: RecoveryAction.GRACEFUL_FAIL, resumePlan: null, recoverable: false };
    }
    if (!withinBudget(record.retryCount, policy) || !shouldRetry(attempt - 1, policy)) {
      await safe(hooks.gracefulFail, record);
      return { outcome: RecoveryOutcome.EXHAUSTED, action: RecoveryAction.GRACEFUL_FAIL, resumePlan: null, recoverable: false };
    }

    const resumePlan = planResume(record.checkpoint ?? { totalTargets: 0 }, { now: this.clock() });

    switch (action) {
      case RecoveryAction.RETRY: {
        const ok = await safe(hooks.retry, record, resumePlan);
        return { outcome: ok ? RecoveryOutcome.RECOVERED : RecoveryOutcome.FAILED, action, resumePlan, recoverable: true };
      }
      case RecoveryAction.REPLAN: {
        const ok = await safe(hooks.replan, record, resumePlan);
        return { outcome: ok ? RecoveryOutcome.RECOVERED : RecoveryOutcome.FAILED, action, resumePlan, recoverable: true };
      }
      case RecoveryAction.RESUME_FROM_CHECKPOINT:
      default: {
        const ok = await safe(hooks.resumeFromCheckpoint, record, resumePlan);
        return { outcome: ok ? RecoveryOutcome.RECOVERED : RecoveryOutcome.FAILED, action: RecoveryAction.RESUME_FROM_CHECKPOINT, resumePlan, recoverable: true };
      }
    }
  }
}

/** Call an (optional) async hook, defaulting a missing hook to optimistic success. */
async function safe(hook, ...args) {
  if (typeof hook !== "function") return true; // no hook injected → engine performs the work + confirms
  try {
    return (await hook(...args)) !== false;
  } catch {
    return false;
  }
}

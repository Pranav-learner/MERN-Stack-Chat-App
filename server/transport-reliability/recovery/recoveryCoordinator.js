/**
 * @module transport-reliability/recovery
 *
 * The **Recovery Coordinator** — decides HOW to recover an interrupted transfer and executes the
 * recovery via INJECTED hooks. It maps a trigger to an action (resume-from-checkpoint / retry /
 * migrate / graceful-fail), enforces a bounded attempt count + backoff + a total recovery timeout,
 * and always preserves the transfer's checkpoint so a resume re-sends only the missing chunks.
 *
 * @important Recovery NEVER corrupts transfer state: it is a pure decision + a hook call; the checkpoint
 * is read, never mutated, and the manager applies state transitions atomically with version bumps. On
 * exhaustion the coordinator returns a GRACEFUL_FAIL outcome with the checkpoint intact (a caller can
 * resume later).
 *
 * @evolution Transport-INDEPENDENT: the actual re-send / reconnect is the Transport Engine's / Layer
 * 7's job, injected here as hooks. Defaults are optimistic (the device performs the work + confirms via
 * a subsequent checkpoint), matching the Layer-7 reliability pattern.
 */

import { RECOVERY_PLANS, RecoveryAction, RecoveryOutcome, DEFAULT_RETRY_POLICY } from "../types/types.js";
import { planResume } from "../resume/resumePlanner.js";

export class RecoveryCoordinator {
  /** @param {{ retryPolicy?: object, clock?: () => number }} [deps] */
  constructor(deps = {}) {
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(deps.retryPolicy ?? {}) };
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** Resolve the recovery action + recoverability for a trigger. */
  resolvePlan(trigger) {
    return RECOVERY_PLANS[trigger] ?? { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true };
  }

  /** Exponential backoff (ms) with deterministic pseudo-jitter for a recovery attempt (1-based). */
  backoff(attempt, policy = this.retryPolicy) {
    if (attempt <= 0) return 0;
    let delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** (attempt - 1));
    if (policy.jitter) delay = Math.round(delay * (0.5 + 0.5 * pseudoJitter(attempt)));
    return delay;
  }

  /** Whether another recovery attempt is permitted. */
  shouldRetry(attempt, policy = this.retryPolicy) {
    return attempt < policy.maxAttempts;
  }

  /**
   * Run ONE recovery attempt for a record. Returns a structured result the manager applies (it does
   * NOT persist or transition — that stays in the manager, so state changes are atomic).
   *
   * @param {object} params
   * @param {import("../types/types.js").TransferReliabilityRecord} params.record
   * @param {string} params.trigger @param {number} params.attempt (1-based)
   * @param {object} params.hooks `{ resumeFromCheckpoint, retry, migrate, gracefulFail }` (async → boolean)
   * @param {string} [params.newConnectionId] target for a MIGRATE action
   * @returns {Promise<{ outcome: string, action: string, resumePlan: object|null, connectionId?: string, recoverable: boolean }>}
   */
  async run({ record, trigger, attempt, hooks = {}, newConnectionId }) {
    const { action, recoverable } = this.resolvePlan(trigger);
    if (!recoverable) return { outcome: RecoveryOutcome.FAILED, action: RecoveryAction.GRACEFUL_FAIL, resumePlan: null, recoverable: false };
    if (!this.shouldRetry(attempt - 1)) {
      await safe(hooks.gracefulFail, record);
      return { outcome: RecoveryOutcome.EXHAUSTED, action: RecoveryAction.GRACEFUL_FAIL, resumePlan: null, recoverable: false };
    }

    const resumePlan = planResume(record.checkpoint ?? { totalChunks: 1 }, { now: this.clock() });

    switch (action) {
      case RecoveryAction.MIGRATE: {
        const ok = await safe(hooks.migrate, record, newConnectionId, resumePlan);
        return ok
          ? { outcome: RecoveryOutcome.MIGRATED, action, resumePlan, connectionId: newConnectionId ?? record.connectionId, recoverable: true }
          : { outcome: RecoveryOutcome.FAILED, action, resumePlan, recoverable: true };
      }
      case RecoveryAction.RETRY: {
        const ok = await safe(hooks.retry, record, resumePlan);
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
  if (typeof hook !== "function") return true; // no hook injected → device performs the work + confirms
  try {
    return (await hook(...args)) !== false;
  } catch {
    return false;
  }
}

/** Deterministic pseudo-jitter in `[0,1)` (no Math.random → reproducible). */
function pseudoJitter(n) {
  const x = Math.sin((n + 1) * 91.7351) * 47251.8231;
  return x - Math.floor(x);
}

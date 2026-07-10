/**
 * @module crypto-hardening/recovery
 *
 * **Production-grade failure recovery.** Turns a well-typed failure into a recovery plan and,
 * where possible, performs graceful cleanup via injected hooks — without ever leaving key
 * material or partial state behind.
 *
 * Handled failures ({@link RecoveryKind}): interrupted encryption/decryption, corrupted
 * metadata, session/chain/generation mismatch, and repository corruption. Each maps to a
 * {@link RecoveryAction} + a cleanup routine (destroy transient keys, reset the replay window,
 * quarantine a bad record, or escalate).
 *
 * @security Recovery is best-effort and idempotent. Cleanup hooks destroy transient key
 * material; the coordinator itself never handles raw keys — it invokes the device-local stores.
 */

import { RecoveryKind, RecoveryAction, HardeningEventType } from "../types/types.js";
import { HardeningEventBus } from "../events/events.js";
import { UnrecoverableError } from "../errors.js";

/** The default plan (action + whether it is recoverable) for each failure kind. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryKind.INTERRUPTED_ENCRYPTION]: { action: RecoveryAction.CLEANUP_AND_RETRY, recoverable: true },
  [RecoveryKind.INTERRUPTED_DECRYPTION]: { action: RecoveryAction.CLEANUP_AND_RETRY, recoverable: true },
  [RecoveryKind.CORRUPTED_METADATA]: { action: RecoveryAction.QUARANTINE_RECORD, recoverable: true },
  [RecoveryKind.SESSION_MISMATCH]: { action: RecoveryAction.DROP_MESSAGE, recoverable: true },
  [RecoveryKind.CHAIN_MISMATCH]: { action: RecoveryAction.RESET_REPLAY_WINDOW, recoverable: true },
  [RecoveryKind.GENERATION_MISMATCH]: { action: RecoveryAction.DROP_MESSAGE, recoverable: true },
  [RecoveryKind.REPOSITORY_CORRUPTION]: { action: RecoveryAction.ESCALATE, recoverable: false },
});

export class RecoveryCoordinator {
  /**
   * @param {object} [deps]
   * @param {HardeningEventBus} [deps.events] @param {import("../observability/metrics.js").MetricsRegistry} [deps.metrics]
   * @param {object} [deps.hooks] cleanup hooks: `{ destroyTransientKeys(ctx), resetReplayWindow(ctx), quarantine(ctx), escalate(ctx) }`
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.metrics = deps.metrics ?? null;
    this.hooks = deps.hooks ?? {};
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** The planned action for a failure kind (without executing anything). */
  plan(kind) {
    return RECOVERY_PLANS[kind] ?? { action: RecoveryAction.ESCALATE, recoverable: false };
  }

  /**
   * Recover from a failure: emit RECOVERY_STARTED, run the mapped cleanup, emit
   * RECOVERY_COMPLETED. Returns the outcome. Throws {@link UnrecoverableError} for
   * non-recoverable kinds (after invoking the escalate hook).
   * @param {{ kind: string, sessionId?: string, context?: object }} failure
   * @returns {Promise<{ kind: string, action: string, recovered: boolean, cleanup: string[] }>}
   */
  async recover(failure) {
    const kind = failure?.kind;
    const plan = this.plan(kind);
    const ctx = { sessionId: failure?.sessionId, ...(failure?.context ?? {}) };
    this.metrics?.increment("recovery_total", 1, { kind });
    this.events.emit(HardeningEventType.RECOVERY_STARTED, { sessionId: ctx.sessionId, reason: kind });

    const cleanup = [];
    try {
      switch (plan.action) {
        case RecoveryAction.CLEANUP_AND_RETRY:
          await this._run("destroyTransientKeys", ctx, cleanup);
          break;
        case RecoveryAction.RESET_REPLAY_WINDOW:
          await this._run("resetReplayWindow", ctx, cleanup);
          break;
        case RecoveryAction.QUARANTINE_RECORD:
          await this._run("quarantine", ctx, cleanup);
          break;
        case RecoveryAction.DROP_MESSAGE:
          cleanup.push("dropped-message");
          break;
        case RecoveryAction.ESCALATE:
        default:
          await this._run("escalate", ctx, cleanup);
          break;
      }
    } catch (error) {
      this.metrics?.increment("recovery_failed_total", 1, { kind });
      throw new UnrecoverableError(`Recovery failed for ${kind}`, { cause: error, details: { kind } });
    }

    if (!plan.recoverable) {
      this.events.emit(HardeningEventType.RECOVERY_COMPLETED, { sessionId: ctx.sessionId, reason: kind, details: { recovered: false, action: plan.action } });
      throw new UnrecoverableError(`Unrecoverable failure: ${kind}`, { details: { kind, action: plan.action } });
    }
    this.metrics?.increment("recovery_completed_total", 1, { kind });
    this.events.emit(HardeningEventType.RECOVERY_COMPLETED, { sessionId: ctx.sessionId, reason: kind, details: { recovered: true, action: plan.action } });
    return { kind, action: plan.action, recovered: true, cleanup };
  }

  /** @private Invoke a cleanup hook if present; record what ran. */
  async _run(hookName, ctx, cleanup) {
    const fn = this.hooks[hookName];
    if (typeof fn === "function") {
      await fn(ctx);
      cleanup.push(hookName);
    }
  }
}

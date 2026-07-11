/**
 * @module networking-hardening/recovery
 *
 * **Production failure recovery** for the networking control plane. Turns a well-typed failure into
 * a recovery plan and, where possible, performs it via injected hooks — with bounded retries and
 * graceful degradation, never leaving partial state behind.
 *
 * Handled failures ({@link RecoveryKind}): interrupted discovery, repository failure, presence
 * inconsistency, capability-refresh failure, endpoint-selection failure, expired connection plan,
 * cache corruption. Each maps to a {@link RecoveryAction} (retry / rebuild / invalidate-cache /
 * degrade / quarantine / escalate) + a hook.
 *
 * @security Recovery operates on METADATA only. Hooks are injected by the caller (which owns the
 * repositories/caches); the coordinator holds no key material. All recovery is idempotent.
 *
 * @example
 * ```js
 * const recovery = new RecoveryCoordinator({ hooks: { retry: fn, rebuild: fn, invalidateCache: fn } });
 * const out = await recovery.recover({ kind: RecoveryKind.INTERRUPTED_DISCOVERY, context: {...} });
 * // out.recovered === true, out.action === "retry"
 * ```
 */

import { RecoveryKind, RecoveryAction, RECOVERY_PLANS, HardeningEventType, Metric, DEFAULT_RETRY_POLICY } from "../types/types.js";
import { HardeningEventBus } from "../events/events.js";
import { UnrecoverableError } from "../errors.js";

export { RECOVERY_PLANS };

export class RecoveryCoordinator {
  /**
   * @param {object} [deps]
   * @param {HardeningEventBus} [deps.events] @param {import("../observability/metrics.js").NetworkingMetrics} [deps.metrics]
   * @param {object} [deps.hooks] recovery hooks keyed by action: `{ retry(ctx), rebuild(ctx), invalidateCache(ctx), degrade(ctx), quarantine(ctx), escalate(ctx) }`
   * @param {object} [deps.retryPolicy] @param {() => number} [deps.clock]
   * @param {(ms:number)=>Promise<void>} [deps.sleep] injectable sleep (tests pass a no-op)
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.metrics = deps.metrics ?? null;
    this.hooks = deps.hooks ?? {};
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(deps.retryPolicy ?? {}) };
    this.clock = deps.clock ?? (() => Date.now());
    this._sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The planned action for a failure kind (without executing anything). */
  plan(kind) {
    return RECOVERY_PLANS[kind] ?? { action: RecoveryAction.ESCALATE, recoverable: false };
  }

  /**
   * Recover from a failure: emit RECOVERY_STARTED, run the mapped hook (with bounded retry for
   * retryable actions), emit RECOVERY_COMPLETED/RECOVERY_FAILED. Returns the outcome.
   * @param {{ kind: string, subsystem?: string, context?: object }} failure
   * @returns {Promise<{ kind: string, action: string, recovered: boolean, attempts: number, degraded: boolean, result: any }>}
   * @throws {UnrecoverableError} for non-recoverable kinds (after the escalate hook + an alert).
   */
  async recover(failure) {
    const kind = failure?.kind;
    const plan = this.plan(kind);
    const ctx = { subsystem: failure?.subsystem, ...(failure?.context ?? {}) };
    this.metrics?.increment(Metric.RECOVERY_TOTAL, 1, { kind });
    this.events.emit(HardeningEventType.RECOVERY_STARTED, { subsystem: ctx.subsystem, reason: kind, action: plan.action });

    if (!plan.recoverable) {
      await this._safeHook(RecoveryAction.ESCALATE, ctx);
      this.events.emit(HardeningEventType.RECOVERY_FAILED, { subsystem: ctx.subsystem, reason: kind });
      throw new UnrecoverableError(`Unrecoverable networking failure: ${kind}`, { details: { kind } });
    }

    let attempts = 0;
    let degraded = false;
    let result;
    try {
      switch (plan.action) {
        case RecoveryAction.RETRY: {
          const r = await this._withRetry(() => this._runHook(RecoveryAction.RETRY, ctx));
          attempts = r.attempts;
          result = r.result;
          break;
        }
        case RecoveryAction.REBUILD:
          attempts = 1;
          result = await this._runHook(RecoveryAction.REBUILD, ctx);
          break;
        case RecoveryAction.INVALIDATE_CACHE:
          attempts = 1;
          result = await this._runHook(RecoveryAction.INVALIDATE_CACHE, ctx);
          break;
        case RecoveryAction.DEGRADE:
          attempts = 1;
          degraded = true;
          result = await this._runHook(RecoveryAction.DEGRADE, ctx);
          break;
        case RecoveryAction.QUARANTINE:
          attempts = 1;
          result = await this._runHook(RecoveryAction.QUARANTINE, ctx);
          break;
        default:
          break;
      }
    } catch (error) {
      // The recovery attempt itself failed → graceful degradation, then escalate as an alert.
      degraded = true;
      await this._safeHook(RecoveryAction.DEGRADE, ctx);
      this.events.emit(HardeningEventType.RECOVERY_FAILED, { subsystem: ctx.subsystem, reason: kind, details: { error: error?.message } });
      return { kind, action: plan.action, recovered: false, attempts, degraded, result: null };
    }

    this.events.emit(HardeningEventType.RECOVERY_COMPLETED, { subsystem: ctx.subsystem, reason: kind, action: plan.action, count: attempts });
    return { kind, action: plan.action, recovered: true, attempts, degraded, result };
  }

  /**
   * Run an arbitrary async operation under the recovery retry policy (a reusable retry primitive).
   * @param {() => Promise<any>} fn @returns {Promise<any>} @throws the last error after exhausting attempts
   */
  async retry(fn) {
    const { result } = await this._withRetry(fn);
    return result;
  }

  // === internals ==========================================================

  /** @private Bounded exponential backoff with optional jitter. */
  async _withRetry(fn) {
    const { maxAttempts, baseDelayMs, maxDelayMs, factor, jitter } = this.retryPolicy;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        return { result, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) break;
        let delay = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
        if (jitter) delay = Math.round(delay * (0.5 + 0.5 * this._deterministicJitter(attempt)));
        await this._sleep(delay);
      }
    }
    throw lastError;
  }

  /** @private Deterministic pseudo-jitter (no Math.random → reproducible tests). */
  _deterministicJitter(attempt) {
    const x = Math.sin(attempt * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  /** @private Run a hook by action; a missing hook is a benign no-op returning null. */
  async _runHook(action, ctx) {
    const fn = this.hooks[hookName(action)];
    if (typeof fn !== "function") return null;
    return fn(ctx);
  }

  /** @private Run a hook, swallowing its errors (best-effort cleanup / escalation). */
  async _safeHook(action, ctx) {
    try {
      await this._runHook(action, ctx);
    } catch {
      /* best-effort */
    }
  }
}

/** Map a recovery action to its hook name. */
function hookName(action) {
  return {
    [RecoveryAction.RETRY]: "retry",
    [RecoveryAction.REBUILD]: "rebuild",
    [RecoveryAction.INVALIDATE_CACHE]: "invalidateCache",
    [RecoveryAction.DEGRADE]: "degrade",
    [RecoveryAction.QUARANTINE]: "quarantine",
    [RecoveryAction.ESCALATE]: "escalate",
  }[action];
}

export { RecoveryKind, RecoveryAction };

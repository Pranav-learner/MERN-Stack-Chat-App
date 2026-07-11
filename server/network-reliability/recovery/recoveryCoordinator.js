/**
 * @module network-reliability/recovery
 *
 * **Automatic connection recovery.** Turns a well-typed {@link RecoveryTrigger} (temporary network
 * loss, WiFi↔mobile transition, NAT rebind, timeout, relay failure, unexpected disconnect,
 * repository failure) into a recovery plan + performs it via INJECTED hooks, with a bounded
 * {@link module:network-reliability/retry RetryController} and graceful failure.
 *
 * @security Recovery PRESERVES the cryptographic session wherever possible: the reconnect keeps the
 * SAME `sessionId` (a transport reconnect, not a new handshake), so forward-secret keys survive. The
 * coordinator never touches key bytes — the injected hooks own the (device-local) session/keys and
 * simply keep the session id stable. When a full re-handshake is unavoidable the hook signals it and
 * the caller decides; recovery never silently drops session continuity.
 *
 * @evolution The hooks (`resume` / `reconnect` / `refreshCandidates` / `switchRelay` / `gracefulFail`)
 * are supplied by the caller (Sprint 2's Connection Manager, or a test double), so the coordinator is
 * transport-independent.
 *
 * @example
 * ```js
 * const recovery = new RecoveryCoordinator({ hooks: { reconnect: async (ctx) => reestablish(ctx) } });
 * const out = await recovery.recover(RecoveryTrigger.UNEXPECTED_DISCONNECT, { connectionId, sessionId });
 * // out.recovered === true, out.sessionPreserved === true
 * ```
 */

import {
  RecoveryTrigger,
  RecoveryAction,
  RECOVERY_PLANS,
  ReliabilityEventType,
  ReliabilityFailureReason,
  Metric,
} from "../types/types.js";
import { RetryController } from "../retry/retryPolicy.js";
import { ReliabilityEventBus } from "../events/events.js";
import { RecoveryFailedError } from "../errors.js";

export { RECOVERY_PLANS };

export class RecoveryCoordinator {
  /**
   * @param {object} [deps]
   * @param {object} [deps.hooks] `{ resume(ctx), reconnect(ctx), refreshCandidates(ctx), switchRelay(ctx), gracefulFail(ctx) }`
   * @param {ReliabilityEventBus} [deps.events] @param {import("../observability/metrics.js").ReliabilityMetrics} [deps.metrics]
   * @param {object} [deps.retryPolicy] @param {() => number} [deps.clock] @param {(ms:number)=>Promise<void>} [deps.sleep]
   */
  constructor(deps = {}) {
    this.hooks = deps.hooks ?? {};
    this.events = deps.events ?? new ReliabilityEventBus();
    this.metrics = deps.metrics ?? null;
    this.retryPolicy = deps.retryPolicy;
    this.clock = deps.clock ?? (() => Date.now());
    this._sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The planned action for a trigger (without executing anything). */
  plan(trigger) {
    return RECOVERY_PLANS[trigger] ?? { action: RecoveryAction.RECONNECT, recoverable: true };
  }

  /**
   * Recover a connection from a trigger. Emits RECOVERY_STARTED, runs the plan (bounded retry),
   * emits RECOVERY_SUCCEEDED/FAILED. @returns {Promise<{ recovered: boolean, action: string, trigger: string, attempts: number, sessionPreserved: boolean, elapsedMs: number, reason?: string }>}
   *
   * @param {string} trigger one of {@link RecoveryTrigger}
   * @param {{ connectionId?: string, sessionId?: string, deviceId?: string, peerId?: string, [k:string]: any }} context
   * @param {{ retryPolicy?: object }} [options]
   */
  async recover(trigger, context = {}, options = {}) {
    const plan = this.plan(trigger);
    const startedAt = this.clock();
    this.metrics?.increment(Metric.RECOVERY_TOTAL, 1, { trigger });
    this.events.emit(ReliabilityEventType.RECOVERY_STARTED, { connectionId: context.connectionId, trigger, action: plan.action });

    if (!plan.recoverable) {
      await this._safe("gracefulFail", context);
      this._fail(context, trigger, ReliabilityFailureReason.UNRECOVERABLE, startedAt);
      throw new RecoveryFailedError(`Unrecoverable trigger: ${trigger}`, { reason: ReliabilityFailureReason.UNRECOVERABLE, details: { trigger } });
    }

    const controller = new RetryController(options.retryPolicy ?? this.retryPolicy, { clock: this.clock, sleep: this._sleep });
    let recovered = false;
    let attempts = 0;

    try {
      // A brief loss can often just resume the session without a full reconnect.
      if (plan.action === RecoveryAction.RESUME_SESSION) {
        recovered = await this._try("resume", context);
        if (!recovered) recovered = await this._reconnectLoop(controller, context, (n) => (attempts = n));
        else attempts = 1;
      } else {
        // Prep step (network changed → refresh candidates; relay failed → switch relay), then reconnect.
        if (plan.action === RecoveryAction.REFRESH_CANDIDATES) await this._safe("refreshCandidates", context);
        if (plan.action === RecoveryAction.SWITCH_RELAY) {
          await this._safe("switchRelay", context);
          this.events.emit(ReliabilityEventType.RELAY_FAILOVER, { connectionId: context.connectionId });
        }
        recovered = await this._reconnectLoop(controller, context, (n) => (attempts = n));
      }
    } catch (error) {
      recovered = false;
    }

    const elapsedMs = this.clock() - startedAt;
    if (recovered) {
      this.metrics?.increment(Metric.RECOVERY_SUCCESS);
      this.metrics?.observe(Metric.RECOVERY_TIME, elapsedMs);
      this.events.emit(ReliabilityEventType.RECOVERY_SUCCEEDED, { connectionId: context.connectionId, trigger, action: plan.action, count: attempts });
      return { recovered: true, action: plan.action, trigger, attempts, sessionPreserved: context.sessionId != null, elapsedMs };
    }

    await this._safe("gracefulFail", context);
    this._fail(context, trigger, ReliabilityFailureReason.RECOVERY_EXHAUSTED, startedAt);
    return { recovered: false, action: plan.action, trigger, attempts, sessionPreserved: false, elapsedMs, reason: ReliabilityFailureReason.RECOVERY_EXHAUSTED };
  }

  // === internals ==========================================================

  /** @private Bounded reconnect loop using the retry controller. */
  async _reconnectLoop(controller, context, onAttempt) {
    for (;;) {
      const { proceed, attempt } = await controller.next();
      if (!proceed) return false;
      onAttempt(attempt);
      this.metrics?.increment(Metric.RECONNECT_TOTAL);
      this.events.emit(ReliabilityEventType.RECONNECT_ATTEMPT, { connectionId: context.connectionId, count: attempt });
      if (await this._try("reconnect", context)) return true;
    }
  }

  /** @private Run a hook; truthy return (or absence of a hook, treated as success for prep steps) = ok. */
  async _try(name, context) {
    const fn = this.hooks[name];
    if (typeof fn !== "function") return name === "resume" ? false : true; // no resume hook → force reconnect
    try {
      const result = await fn(context);
      return result !== false && result !== null && result !== undefined ? true : false;
    } catch {
      return false;
    }
  }

  /** @private Run a best-effort hook, swallowing errors. */
  async _safe(name, context) {
    const fn = this.hooks[name];
    if (typeof fn !== "function") return;
    try {
      await fn(context);
    } catch {
      /* best-effort */
    }
  }

  /** @private Emit + count a recovery failure. */
  _fail(context, trigger, reason, startedAt) {
    this.metrics?.increment(Metric.RECOVERY_FAILURE);
    this.metrics?.observe(Metric.RECOVERY_TIME, this.clock() - startedAt);
    this.events.emit(ReliabilityEventType.RECOVERY_FAILED, { connectionId: context.connectionId, trigger, reason });
  }
}

export { RecoveryTrigger, RecoveryAction };

/**
 * @module shs/hardening/recovery/recoveryManager
 *
 * Handshake recovery strategies. Classifies a failure and decides whether to
 * **resume** an interrupted handshake, **retry** a timed-out one (with the Sprint 1
 * {@link RetryPolicy} backoff), **wait** on a transient network blip, or **abort** an
 * unrecoverable one. It drives the existing {@link HandshakeManager} operations — it
 * adds no new protocol, only orchestration + policy.
 *
 * @security No secrets. Recovery reasons/decisions are public metadata; the manager's
 * own state-machine guards still apply to every action it triggers.
 */

import { HandshakeState, FailureReason, isTerminalState } from "../../types.js";
import { RetryPolicy } from "../../retry/retry.js";
import { RecoveryAction, FailureClass, HardeningEventType } from "../types.js";
import { UnrecoverableError } from "../errors.js";

/** Failure reasons that are transient (retry/wait). */
const TRANSIENT = new Set([FailureReason.TIMEOUT, FailureReason.INTERNAL_ERROR]);
/** Failure reasons that are permanent (abort). */
const PERMANENT = new Set([
  FailureReason.VERSION_INCOMPATIBLE,
  FailureReason.CAPABILITY_MISMATCH,
  FailureReason.UNKNOWN_IDENTITY,
  FailureReason.UNKNOWN_DEVICE,
  FailureReason.UNTRUSTED_DEVICE,
  FailureReason.MALFORMED_MESSAGE,
  FailureReason.DUPLICATE_REQUEST,
  FailureReason.USER_REJECTED,
  FailureReason.USER_CANCELLED,
  FailureReason.PROTOCOL_ERROR,
]);

/**
 * Classify a failure by reason + state.
 * @param {{ reason?: string, state?: string }} params
 * @returns {string} one of {@link FailureClass}
 */
export function classifyFailure({ reason, state } = {}) {
  if (reason && PERMANENT.has(reason)) return FailureClass.PERMANENT;
  if (reason === FailureReason.EXPIRED_SESSION || state === HandshakeState.EXPIRED) return FailureClass.PERMANENT;
  if (reason && TRANSIENT.has(reason)) return FailureClass.TRANSIENT;
  // Interrupted but non-terminal → recoverable (resumable).
  if (state && !isTerminalState(state)) return FailureClass.RECOVERABLE;
  if (state === HandshakeState.TIMED_OUT) return FailureClass.TRANSIENT;
  return FailureClass.RECOVERABLE;
}

/**
 * Decide the recovery action for a session + failure, honouring the retry budget.
 * @param {object} session the handshake session (public DTO or record)
 * @param {{ reason?: string, retryPolicy?: RetryPolicy }} [context]
 * @returns {{ action: string, class: string, delayMs?: number, reason?: string }}
 */
export function decideRecovery(session, context = {}) {
  const cls = classifyFailure({ reason: context.reason, state: session.state });
  const retryPolicy = context.retryPolicy ?? new RetryPolicy();

  if (cls === FailureClass.PERMANENT) {
    return { action: RecoveryAction.ABORT, class: cls, reason: context.reason };
  }
  if (cls === FailureClass.RECOVERABLE && !isTerminalState(session.state)) {
    return { action: RecoveryAction.RESUME, class: cls };
  }
  // Transient or terminal-timeout: retry within budget, else abort.
  if (retryPolicy.canRetry(session.retryCount ?? 0)) {
    return { action: RecoveryAction.RETRY, class: cls, delayMs: retryPolicy.nextDelay(session.retryCount ?? 0) };
  }
  return { action: RecoveryAction.ABORT, class: cls, reason: FailureReason.RETRY_EXHAUSTED };
}

/**
 * The Recovery Manager: applies {@link decideRecovery} by driving a
 * {@link HandshakeManager}. Emits recovery events for observability.
 */
export class RecoveryManager {
  /**
   * @param {object} deps
   * @param {object} deps.handshakes a HandshakeManager
   * @param {RetryPolicy} [deps.retryPolicy]
   * @param {{ emit: Function }} [deps.events] a hardening event bus
   */
  constructor(deps) {
    if (!deps || !deps.handshakes) throw new Error("RecoveryManager requires { handshakes }");
    this.handshakes = deps.handshakes;
    this.retryPolicy = deps.retryPolicy ?? new RetryPolicy();
    this.events = deps.events ?? null;
  }

  /**
   * Attempt to recover a handshake by id. Resolves the current session, decides an
   * action, and performs it via the HandshakeManager.
   *
   * @param {string} handshakeId @param {string} actingUser
   * @param {{ reason?: string }} [context]
   * @returns {Promise<{ action: string, session?: object, message?: object, delayMs?: number }>}
   * @throws {UnrecoverableError} when the decision is ABORT
   */
  async recover(handshakeId, actingUser, context = {}) {
    const session = await this.handshakes.getHandshake(handshakeId, { actingUser });
    const decision = decideRecovery(session, { reason: context.reason ?? session.reason, retryPolicy: this.retryPolicy });
    this._emit(HardeningEventType.RECOVERY_ATTEMPTED, { handshakeId, details: decision });

    switch (decision.action) {
      case RecoveryAction.RESUME: {
        const result = await this.handshakes.resumeHandshake(handshakeId, actingUser);
        this._emit(HardeningEventType.RECOVERY_SUCCEEDED, { handshakeId, details: { action: "resume" } });
        return { action: RecoveryAction.RESUME, ...result };
      }
      case RecoveryAction.RETRY: {
        const result = await this.handshakes.restartHandshake(handshakeId, actingUser);
        this._emit(HardeningEventType.RECOVERY_SUCCEEDED, { handshakeId, details: { action: "retry", delayMs: decision.delayMs } });
        // The RecoveryManager's retry policy governs the recovery backoff, so its
        // decision wins over the handshake manager's own restart delay.
        return { action: RecoveryAction.RETRY, ...result, delayMs: decision.delayMs };
      }
      case RecoveryAction.WAIT:
        return { action: RecoveryAction.WAIT, delayMs: decision.delayMs };
      case RecoveryAction.ABORT:
      default: {
        await this._safeAbort(handshakeId);
        this._emit(HardeningEventType.RECOVERY_ABORTED, { handshakeId, reason: decision.reason });
        throw new UnrecoverableError(`Handshake ${handshakeId} is unrecoverable`, { details: decision });
      }
    }
  }

  /** @private Abort without throwing if the session is already terminal. */
  async _safeAbort(handshakeId) {
    try {
      await this.handshakes.abortHandshake(handshakeId, FailureReason.INTERNAL_ERROR);
    } catch {
      /* already terminal — nothing to abort */
    }
  }

  _emit(type, payload) {
    if (this.events) this.events.emit(type, payload);
  }
}

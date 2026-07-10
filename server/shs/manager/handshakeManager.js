/**
 * @module shs/manager
 *
 * The **Handshake Manager** — the reusable facade for the Secure Handshake Protocol
 * (Layer 4, Sprint 1). It owns the handshake lifecycle: starting, accepting,
 * rejecting, cancelling, completing, resuming, restarting, expiring, and timing out
 * sessions, driving each transition through the deterministic state machine and
 * emitting typed events for future layers.
 *
 * ## What this does NOT do (Sprint 1)
 * There is **no** cryptographic key exchange, **no** shared secret, **no** session
 * key, and **no** message encryption here. `completeHandshake` means "the protocol
 * framework agreed on version + capabilities", not "keys were exchanged". A future
 * sprint plugs ECDH / ratchet logic INTO this manager (e.g. subscribing to the
 * `accepted` event, or extending `completeHandshake`) without redesigning it.
 *
 * @security Operates on PUBLIC protocol metadata only. Optional `identityLookup` /
 * `deviceLookup` hooks let it reject unknown identities/devices; when absent (tests)
 * those checks are skipped.
 *
 * @example Production wiring
 * ```js
 * import { HandshakeManager, createMongoShsRepository } from "./shs/index.js";
 * const handshakes = new HandshakeManager({
 *   ...createMongoShsRepository(),
 *   identityLookup: (u) => identityManager.getIdentityByUser(u),
 *   deviceLookup: (u, d) => deviceManager.getDevice(u, d),
 * });
 * const { session, message } = await handshakes.startHandshake({
 *   initiator: "alice", responder: "bob", initiatorDevice: "dev-a",
 * });
 * ```
 */

import crypto from "node:crypto";
import {
  HandshakeState,
  HandshakeEventType,
  MessageType,
  FailureReason,
  ActorType,
  isTerminalState,
} from "../types.js";
import {
  HandshakeNotFoundError,
  HandshakeOwnershipError,
  DuplicateHandshakeError,
  ProtocolVersionError,
  NegotiationError,
  RetryExhaustedError,
  HandshakeValidationError,
  HandshakeExpiredError,
} from "../errors.js";
import { assertTransition } from "../state-machine/stateMachine.js";
import { createSession, isResumable, roleOf, isParty } from "../sessions/session.js";
import { validateParties, isExpired } from "../validators/validators.js";
import { negotiate } from "../negotiation/negotiation.js";
import {
  CURRENT_VERSION,
  MINIMUM_VERSION,
  featuresForVersion,
} from "../protocol/version.js";
import { DEFAULT_HANDSHAKE_TTL_MS } from "../protocol/constants.js";
import {
  buildRequest,
  buildAccept,
  buildReject,
  buildCancel,
  buildResume,
  buildComplete,
  buildFailure,
} from "../messages/messages.js";
import { toPublicSession } from "../serializers/sessionSerializer.js";
import { HandshakeEventBus } from "../events/events.js";
import { RetryPolicy } from "../retry/retry.js";

/**
 * @typedef {object} HandshakeManagerDeps
 * @property {object} sessions session repository (see repository contract)
 * @property {(userId: string) => Promise<object|null>} [identityLookup] resolve a user's identity
 * @property {(userId: string, deviceId: string) => Promise<object|null>} [deviceLookup] resolve a device
 * @property {HandshakeEventBus} [events]
 * @property {RetryPolicy} [retryPolicy]
 * @property {() => number} [clock]
 * @property {() => string} [idGenerator]
 * @property {string} [currentVersion]
 * @property {string} [minVersion]
 * @property {number} [ttlMs] default whole-handshake lifetime
 * @property {string[]} [requiredCapabilities] capabilities that MUST be negotiated
 */

export class HandshakeManager {
  /** @param {HandshakeManagerDeps} deps */
  constructor(deps) {
    if (!deps || !deps.sessions) {
      throw new Error("HandshakeManager requires { sessions }");
    }
    this.sessions = deps.sessions;
    this.identityLookup = deps.identityLookup ?? null;
    this.deviceLookup = deps.deviceLookup ?? null;
    this.events = deps.events ?? new HandshakeEventBus();
    this.retryPolicy = deps.retryPolicy ?? new RetryPolicy();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.currentVersion = deps.currentVersion ?? CURRENT_VERSION;
    this.minVersion = deps.minVersion ?? MINIMUM_VERSION;
    this.ttlMs = deps.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS;
    this.requiredCapabilities = deps.requiredCapabilities ?? [];
  }

  // === lifecycle: start ====================================================

  /**
   * Start a handshake. Validates the parties, guards against a duplicate live
   * handshake for the same pair, creates the session and advances it
   * `CREATED → INITIALIZED → WAITING`, and returns the initiator's REQUEST message.
   *
   * @param {object} params
   * @param {string} params.initiator @param {string} params.responder
   * @param {string} params.initiatorDevice @param {string} [params.responderDevice]
   * @param {string} [params.version] @param {string} [params.minVersion]
   * @param {string[]} [params.capabilities] @param {object} [params.metadata]
   * @param {number} [params.ttlMs]
   * @returns {Promise<{ session: object, message: object }>}
   * @throws {HandshakeValidationError | UnknownPartyError | DuplicateHandshakeError}
   */
  async startHandshake(params) {
    await validateParties(params, { identityLookup: this.identityLookup, deviceLookup: this.deviceLookup });

    const existing = await this.sessions.findActiveByPair(params.initiator, params.responder);
    if (existing) {
      throw new DuplicateHandshakeError("A handshake between these parties is already in progress", {
        details: { handshakeId: existing.handshakeId, state: existing.state },
      });
    }

    const capabilities = params.capabilities ?? featuresForVersion(params.version ?? this.currentVersion);
    let session = createSession({
      ...params,
      version: params.version ?? this.currentVersion,
      minVersion: params.minVersion ?? this.minVersion,
      capabilities,
      ttlMs: params.ttlMs ?? this.ttlMs,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    await this.sessions.create(session);

    session = await this._advance(session, HandshakeState.INITIALIZED);
    session = await this._advance(session, HandshakeState.WAITING);

    this.events.emit(HandshakeEventType.STARTED, {
      handshakeId: session.handshakeId,
      initiator: session.initiator,
      responder: session.responder,
      state: session.state,
    });

    const message = buildRequest(
      {
        handshakeId: session.handshakeId,
        initiator: session.initiator,
        responder: session.responder,
        initiatorDevice: session.initiatorDevice,
        responderDevice: session.responderDevice,
        version: session.protocolVersion,
        minVersion: session.minVersion,
        capabilities: session.proposedCapabilities,
        metadata: session.metadata,
      },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message };
  }

  // === lifecycle: accept / negotiate ======================================

  /**
   * The responder accepts a WAITING handshake. Runs version + capability
   * negotiation and advances `WAITING → NEGOTIATING`, returning the ACCEPT message.
   * If negotiation fails, the handshake is transitioned to FAILED and the error is
   * rethrown.
   *
   * @param {string} handshakeId @param {string} actingUser must be the responder
   * @param {{ responderDevice?: string, version?: string, capabilities?: string[] }} [options]
   * @returns {Promise<{ session: object, message: object }>}
   * @throws {HandshakeOwnershipError | ProtocolVersionError | NegotiationError}
   */
  async acceptHandshake(handshakeId, actingUser, options = {}) {
    let session = await this._requireSession(handshakeId);
    this._assertRole(session, actingUser, "responder");
    session = await this._refreshExpiry(session);
    this._assertNotExpired(session);

    const responderVersion = options.version ?? this.currentVersion;
    const responderCaps = options.capabilities ?? featuresForVersion(responderVersion);

    let result;
    try {
      result = negotiate(
        { version: session.protocolVersion, capabilities: session.proposedCapabilities },
        { version: responderVersion, capabilities: responderCaps },
        { required: this.requiredCapabilities },
      );
    } catch (error) {
      const reason =
        error instanceof ProtocolVersionError
          ? FailureReason.VERSION_INCOMPATIBLE
          : error instanceof NegotiationError
            ? FailureReason.CAPABILITY_MISMATCH
            : FailureReason.PROTOCOL_ERROR;
      await this._terminate(session, HandshakeState.FAILED, {
        reason,
        terminatedBy: ActorType.RESPONDER,
        event: HandshakeEventType.FAILED,
      });
      throw error;
    }

    session = await this._advance(session, HandshakeState.NEGOTIATING, {
      patch: {
        protocolVersion: result.version,
        negotiatedCapabilities: result.capabilities,
        responderDevice: options.responderDevice ?? session.responderDevice,
      },
    });

    this.events.emit(HandshakeEventType.NEGOTIATING, {
      handshakeId: session.handshakeId,
      state: session.state,
      details: { version: result.version, capabilities: result.capabilities },
    });
    this.events.emit(HandshakeEventType.ACCEPTED, {
      handshakeId: session.handshakeId,
      initiator: session.initiator,
      responder: session.responder,
    });

    const message = buildAccept(
      {
        handshakeId: session.handshakeId,
        responder: session.responder,
        initiator: session.initiator,
        responderDevice: session.responderDevice,
        version: result.version,
        negotiatedCapabilities: result.capabilities,
      },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message };
  }

  /**
   * Complete a NEGOTIATING handshake (either party). Advances `NEGOTIATING →
   * COMPLETED`. In Sprint 1 this finalizes the protocol framework only — no keys
   * are exchanged.
   * @param {string} handshakeId @param {string} actingUser
   * @returns {Promise<{ session: object, message: object }>}
   */
  async completeHandshake(handshakeId, actingUser) {
    let session = await this._requireSession(handshakeId);
    this._assertParty(session, actingUser);
    session = await this._refreshExpiry(session);
    this._assertNotExpired(session);

    session = await this._terminate(session, HandshakeState.COMPLETED, {
      terminatedBy: roleOf(session, actingUser) === "responder" ? ActorType.RESPONDER : ActorType.INITIATOR,
      event: HandshakeEventType.COMPLETED,
    });

    const message = buildComplete(
      {
        handshakeId: session.handshakeId,
        from: String(actingUser),
        to: roleOf(session, actingUser) === "responder" ? session.initiator : session.responder,
        version: session.protocolVersion,
        negotiatedCapabilities: session.negotiatedCapabilities,
      },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message };
  }

  // === lifecycle: negative terminals ======================================

  /** The responder rejects the handshake. `WAITING|NEGOTIATING → REJECTED`. */
  async rejectHandshake(handshakeId, actingUser, reason = FailureReason.USER_REJECTED) {
    let session = await this._requireSession(handshakeId);
    this._assertRole(session, actingUser, "responder");
    session = await this._terminate(session, HandshakeState.REJECTED, {
      reason,
      terminatedBy: ActorType.RESPONDER,
      event: HandshakeEventType.REJECTED,
    });
    const message = buildReject(
      { handshakeId, responder: session.responder, initiator: session.initiator, reason },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message };
  }

  /** The initiator cancels the handshake. Any active state → CANCELLED. */
  async cancelHandshake(handshakeId, actingUser, reason = FailureReason.USER_CANCELLED) {
    let session = await this._requireSession(handshakeId);
    this._assertRole(session, actingUser, "initiator");
    session = await this._terminate(session, HandshakeState.CANCELLED, {
      reason,
      terminatedBy: ActorType.INITIATOR,
      event: HandshakeEventType.CANCELLED,
    });
    const message = buildCancel(
      { handshakeId, initiator: session.initiator, responder: session.responder, reason },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message };
  }

  /** Fail the handshake (protocol/validation error). Any active state → FAILED. */
  async failHandshake(handshakeId, reason = FailureReason.PROTOCOL_ERROR, details = {}) {
    let session = await this._requireSession(handshakeId);
    session = await this._terminate(session, HandshakeState.FAILED, {
      reason,
      terminatedBy: ActorType.SYSTEM,
      event: HandshakeEventType.FAILED,
      details,
    });
    const message = buildFailure(
      { handshakeId, from: undefined, to: undefined, reason, details },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message };
  }

  /** Force-abort a handshake (system/admin/recovery). Any active state → ABORTED. */
  async abortHandshake(handshakeId, reason = FailureReason.INTERNAL_ERROR) {
    let session = await this._requireSession(handshakeId);
    session = await this._terminate(session, HandshakeState.ABORTED, {
      reason,
      terminatedBy: ActorType.SYSTEM,
      event: HandshakeEventType.ABORTED,
    });
    return { session: toPublicSession(session) };
  }

  /** Mark a handshake TIMED_OUT (a step deadline elapsed). */
  async timeoutHandshake(handshakeId, reason = FailureReason.TIMEOUT) {
    let session = await this._requireSession(handshakeId);
    session = await this._terminate(session, HandshakeState.TIMED_OUT, {
      reason,
      terminatedBy: ActorType.SYSTEM,
      event: HandshakeEventType.TIMEOUT,
    });
    return { session: toPublicSession(session) };
  }

  /** Mark a handshake EXPIRED (its whole-session deadline passed). */
  async expireHandshake(handshakeId) {
    let session = await this._requireSession(handshakeId);
    session = await this._terminate(session, HandshakeState.EXPIRED, {
      reason: FailureReason.EXPIRED_SESSION,
      terminatedBy: ActorType.SYSTEM,
      event: HandshakeEventType.EXPIRED,
    });
    return { session: toPublicSession(session) };
  }

  // === lifecycle: resume / restart ========================================

  /**
   * Resume a non-terminal handshake — re-signals intent to continue without
   * changing state. Returns a RESUME message. Throws if the session is terminal or
   * expired.
   * @param {string} handshakeId @param {string} actingUser
   * @returns {Promise<{ session: object, message: object }>}
   */
  async resumeHandshake(handshakeId, actingUser) {
    const session = await this._requireSession(handshakeId);
    this._assertParty(session, actingUser);
    if (!isResumable(session, this.clock())) {
      throw new HandshakeValidationError("Handshake is not resumable", {
        details: { handshakeId, state: session.state },
      });
    }
    this.events.emit(HandshakeEventType.RESUMED, {
      handshakeId,
      state: session.state,
      details: { by: String(actingUser) },
    });
    const message = buildResume(
      {
        handshakeId,
        from: String(actingUser),
        to: roleOf(session, actingUser) === "responder" ? session.initiator : session.responder,
        fromState: session.state,
      },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session, { role: roleOf(session, actingUser) }), message };
  }

  /**
   * Restart a handshake after a terminal failure. Creates a NEW session that
   * references the previous one, subject to the retry budget. The original session
   * is left untouched (terminal states are immutable). Returns the new session + a
   * fresh REQUEST message and the recommended backoff delay.
   *
   * @param {string} handshakeId the terminal session to restart
   * @param {string} actingUser must be the initiator
   * @returns {Promise<{ session: object, message: object, delayMs: number }>}
   * @throws {RetryExhaustedError | HandshakeValidationError}
   */
  async restartHandshake(handshakeId, actingUser) {
    const previous = await this._requireSession(handshakeId);
    this._assertRole(previous, actingUser, "initiator");
    if (!isTerminalState(previous.state)) {
      throw new HandshakeValidationError("Only a terminated handshake can be restarted", {
        details: { handshakeId, state: previous.state },
      });
    }
    if (!this.retryPolicy.canRetry(previous.retryCount)) {
      throw new RetryExhaustedError("Retry budget exhausted for this handshake", {
        details: { handshakeId, retryCount: previous.retryCount, maxRetries: this.retryPolicy.maxRetries },
      });
    }

    const delayMs = this.retryPolicy.nextDelay(previous.retryCount);
    let session = createSession({
      initiator: previous.initiator,
      responder: previous.responder,
      initiatorDevice: previous.initiatorDevice,
      responderDevice: previous.responderDevice,
      version: previous.protocolVersion,
      minVersion: previous.minVersion,
      capabilities: previous.proposedCapabilities,
      metadata: previous.metadata,
      ttlMs: this.ttlMs,
      previousHandshakeId: previous.handshakeId,
      retryCount: previous.retryCount + 1,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    await this.sessions.create(session);
    session = await this._advance(session, HandshakeState.INITIALIZED);
    session = await this._advance(session, HandshakeState.WAITING);

    this.events.emit(HandshakeEventType.RESTARTED, {
      handshakeId: session.handshakeId,
      initiator: session.initiator,
      responder: session.responder,
      details: { previousHandshakeId: previous.handshakeId, retryCount: session.retryCount },
    });

    const message = buildRequest(
      {
        handshakeId: session.handshakeId,
        initiator: session.initiator,
        responder: session.responder,
        initiatorDevice: session.initiatorDevice,
        version: session.protocolVersion,
        minVersion: session.minVersion,
        capabilities: session.proposedCapabilities,
        metadata: session.metadata,
      },
      { clock: this.clock, idGenerator: this.idGenerator },
    );
    return { session: toPublicSession(session), message, delayMs };
  }

  // === queries =============================================================

  /**
   * Look up a handshake, lazily expiring it if its deadline has passed while active.
   * @param {string} handshakeId @param {{ actingUser?: string }} [options]
   * @returns {Promise<object>} the public session DTO
   * @throws {HandshakeNotFoundError}
   */
  async getHandshake(handshakeId, options = {}) {
    let session = await this._requireSession(handshakeId);
    session = await this._refreshExpiry(session, { silent: true });
    const role = options.actingUser ? roleOf(session, options.actingUser) : undefined;
    return toPublicSession(session, { role });
  }

  /** Alias for {@link getHandshake}. */
  async getStatus(handshakeId, options) {
    return this.getHandshake(handshakeId, options);
  }

  /** The live handshake between a pair, or null. */
  async getActiveBetween(initiator, responder) {
    const session = await this.sessions.findActiveByPair(initiator, responder);
    return session ? toPublicSession(session) : null;
  }

  /** List every handshake a user is a party to (initiator or responder). */
  async listSessions(userId) {
    const records = await this.sessions.listByUser(userId);
    return records.map((s) => toPublicSession(s, { role: roleOf(s, userId) }));
  }

  /** List handshakes currently in a given state. */
  async listByState(state) {
    return (await this.sessions.findByState(state)).map((s) => toPublicSession(s));
  }

  /**
   * Validate a session is currently in one of the expected states (a guard for
   * callers/future layers before performing a state-specific operation).
   * @param {string} handshakeId @param {string|string[]} expected
   * @returns {Promise<object>} the session DTO if valid
   * @throws {HandshakeValidationError}
   */
  async validateState(handshakeId, expected) {
    const session = await this._requireSession(handshakeId);
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(session.state)) {
      throw new HandshakeValidationError(`Handshake is ${session.state}, expected one of ${allowed.join(", ")}`, {
        details: { handshakeId, state: session.state, expected: allowed },
      });
    }
    return toPublicSession(session);
  }

  /**
   * Expire every active session whose deadline has elapsed. Safe to run
   * periodically. Delegates to {@link expireHandshake} so each transition is
   * guarded and emits an event.
   * @returns {Promise<{ expired: number, handshakeIds: string[] }>}
   */
  async sweepExpired() {
    const all = await this.sessions.listAll();
    const now = this.clock();
    const stale = all.filter((s) => !isTerminalState(s.state) && isExpired(s, now));
    const handshakeIds = [];
    for (const s of stale) {
      try {
        await this.expireHandshake(s.handshakeId);
        handshakeIds.push(s.handshakeId);
      } catch {
        /* another actor may have terminated it concurrently — skip */
      }
    }
    return { expired: handshakeIds.length, handshakeIds };
  }

  // === internals ==========================================================

  /** @private @throws {HandshakeNotFoundError} */
  async _requireSession(handshakeId) {
    const session = await this.sessions.findById(handshakeId);
    if (!session) throw new HandshakeNotFoundError("Handshake not found", { details: { handshakeId } });
    return session;
  }

  /** @private Advance a session one non-terminal step, persisting state + history. */
  async _advance(session, toState, options = {}) {
    assertTransition(session.state, toState);
    const nowIso = new Date(this.clock()).toISOString();
    const patch = {
      state: toState,
      history: [...(session.history ?? []), { from: session.state, to: toState, at: nowIso, reason: options.reason }],
      updatedAt: nowIso,
      ...(options.patch ?? {}),
    };
    const updated = await this.sessions.update(session.handshakeId, patch);
    this.events.emit(HandshakeEventType.STATE_CHANGED, {
      handshakeId: session.handshakeId,
      previousState: session.state,
      state: toState,
    });
    return updated;
  }

  /** @private Transition a session to a state, marking terminal metadata + event. */
  async _terminate(session, toState, options = {}) {
    assertTransition(session.state, toState);
    const nowIso = new Date(this.clock()).toISOString();
    const terminal = isTerminalState(toState);
    const patch = {
      state: toState,
      reason: options.reason ?? session.reason,
      terminatedBy: options.terminatedBy ?? session.terminatedBy,
      history: [
        ...(session.history ?? []),
        { from: session.state, to: toState, at: nowIso, reason: options.reason },
      ],
      updatedAt: nowIso,
      ...(terminal ? { completedAt: nowIso } : {}),
      ...(options.patch ?? {}),
    };
    const updated = await this.sessions.update(session.handshakeId, patch);
    this.events.emit(HandshakeEventType.STATE_CHANGED, {
      handshakeId: session.handshakeId,
      previousState: session.state,
      state: toState,
      reason: options.reason,
    });
    if (options.event) {
      this.events.emit(options.event, {
        handshakeId: session.handshakeId,
        initiator: session.initiator,
        responder: session.responder,
        state: toState,
        reason: options.reason,
        details: options.details,
      });
    }
    return updated;
  }

  /**
   * @private If a session is active but past its deadline, expire it. Returns the
   * (possibly updated) session. `silent` still performs the expiry (it is a real
   * state change) but is used by read paths.
   */
  async _refreshExpiry(session, options = {}) {
    if (!isTerminalState(session.state) && isExpired(session, this.clock())) {
      return this._terminate(session, HandshakeState.EXPIRED, {
        reason: FailureReason.EXPIRED_SESSION,
        terminatedBy: ActorType.SYSTEM,
        event: options.silent ? undefined : HandshakeEventType.EXPIRED,
      });
    }
    return session;
  }

  /** @private Throw if a session has reached a terminal state (e.g. just expired). */
  _assertNotExpired(session) {
    if (session.state === HandshakeState.EXPIRED) {
      throw new HandshakeExpiredError("Handshake session has expired", {
        details: { handshakeId: session.handshakeId },
      });
    }
    if (isTerminalState(session.state)) {
      throw new HandshakeValidationError(`Handshake is already ${session.state}`, {
        details: { handshakeId: session.handshakeId, state: session.state },
      });
    }
  }

  /** @private @throws {HandshakeOwnershipError} */
  _assertParty(session, userId) {
    if (!isParty(session, userId)) {
      throw new HandshakeOwnershipError("Caller is not a party to this handshake", {
        details: { handshakeId: session.handshakeId },
      });
    }
  }

  /** @private @throws {HandshakeOwnershipError} */
  _assertRole(session, userId, role) {
    if (roleOf(session, userId) !== role) {
      throw new HandshakeOwnershipError(`Only the ${role} may perform this action`, {
        details: { handshakeId: session.handshakeId, requiredRole: role },
      });
    }
  }
}

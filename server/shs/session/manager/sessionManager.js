/**
 * @module shs/session/manager
 *
 * The **Secure Session Manager** — the reusable facade for Layer 4, Sprint 3. It
 * turns a Sprint 2 shared secret into a complete Secure Session and owns the session
 * lifecycle: create/establish, load, resume, close, destroy, validate, rotate
 * metadata, track activity, expire, and rekey. Future layers use THIS manager rather
 * than touching session storage directly.
 *
 * ## Two modes (mirrors Sprint 2)
 * - **Device mode** (client / reference / tests) — constructed with a
 *   {@link SecureKeyStore}. `establishSession` derives session keys from the shared
 *   secret, stores them locally, and can `loadSessionKeys` / `rekey` / issue resume
 *   tokens. The raw keys never leave the device.
 * - **Descriptor mode** (server) — constructed WITHOUT a key store. `registerSession`
 *   records the session METADATA a device established locally; lifecycle operations
 *   (resume/close/activity/validate/expire) work on metadata. The server never holds
 *   keys or secrets.
 *
 * @security Session records + DTOs carry key METADATA only. Raw keys + shared secrets
 * live solely in the device-local key store. This sprint does NOT encrypt messages.
 *
 * @example Device
 * ```js
 * const sessions = new SecureSessionManager({ ...createInMemorySessionRepository(), keyStore: new SecureKeyStore() });
 * const s = await sessions.establishSession({ handshakeId, participants: ["alice","bob"], sharedSecret });
 * const keys = sessions.loadSessionKeys(s.sessionId); // device-local, for a FUTURE encryption layer
 * ```
 */

import crypto from "node:crypto";
import { SessionState, SessionEventType, SessionFailureReason } from "../types.js";
import {
  SessionValidationError,
  DeviceModeRequiredError,
  CorruptedMetadataError,
} from "../errors.js";
import { assertTransition } from "../lifecycle/lifecycle.js";
import { deriveSessionKeys } from "../derivation/sessionKeys.js";
import { createSecureSession, DEFAULT_MAX_LIFETIME_MS, DEFAULT_IDLE_TIMEOUT_MS } from "../model/secureSession.js";
import { isExpired, shouldGoIdle, activityStamp, selectExpired } from "../expiration/expiration.js";
import { issueResumeToken, verifyResumeToken, resumeMetadata } from "../resumption/resumption.js";
import { resolveStrategy, rekeyRecord, canRekey } from "../rekey/rekey.js";
import {
  validateSessionId,
  requireSession,
  validateMetadata,
  assertNoDuplicate,
  assertParticipant,
  validateRepository,
} from "../validators/validators.js";
import { toPublicSession } from "../serialization/sessionSerializer.js";
import { SessionEventBus } from "../events/events.js";

export class SecureSessionManager {
  /**
   * @param {object} deps
   * @param {object} deps.sessions session repository (required)
   * @param {import("../storage/secureKeyStore.js").SecureKeyStore} [deps.keyStore] device-local key store (device mode)
   * @param {SessionEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {string|Function} [deps.rekeyStrategy] default rekey strategy
   * @param {number} [deps.maxLifetimeMs] @param {number} [deps.idleTimeoutMs]
   */
  constructor(deps) {
    if (!deps || !deps.sessions) throw new Error("SecureSessionManager requires { sessions }");
    this.sessions = validateRepository(deps.sessions);
    this.keyStore = deps.keyStore ?? null;
    this.events = deps.events ?? new SessionEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.rekeyStrategy = deps.rekeyStrategy ?? "hkdf-generation";
    this.maxLifetimeMs = deps.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  // === creation ============================================================

  /**
   * Establish a Secure Session from a shared secret (DEVICE mode). Derives the
   * session keys, stores them locally, creates the metadata record, and activates it.
   *
   * @param {object} params
   * @param {string} params.handshakeId
   * @param {string[]} params.participants [initiatorUserId, responderUserId]
   * @param {Buffer|Uint8Array} params.sharedSecret the Sprint 2 shared secret
   * @param {{ initiator?: string, responder?: string }} [params.deviceIds]
   * @param {string} [params.protocolVersion] @param {number} [params.maxLifetimeMs] @param {number} [params.idleTimeoutMs]
   * @param {object} [params.metadata] @param {string} [params.sessionId]
   * @returns {Promise<object>} the public session DTO
   * @throws {DeviceModeRequiredError | DuplicateSessionError | SessionValidationError}
   */
  async establishSession(params) {
    if (!this.keyStore) throw new DeviceModeRequiredError("establishSession requires a device-local key store");
    this._validateParticipants(params.participants);
    assertNoDuplicate(await this.sessions.findActiveByHandshake(params.handshakeId));

    const sharedSecret = Buffer.isBuffer(params.sharedSecret) ? params.sharedSecret : Buffer.from(params.sharedSecret);
    const derivationContext = {
      handshakeId: params.handshakeId,
      participants: params.participants,
      deviceIds: params.deviceIds,
      protocolVersion: params.protocolVersion ?? "1.0",
    };
    const keys = deriveSessionKeys(sharedSecret, derivationContext);

    const record = createSecureSession({
      sessionId: params.sessionId,
      handshakeId: params.handshakeId,
      participants: params.participants,
      deviceIds: params.deviceIds,
      protocolVersion: derivationContext.protocolVersion,
      encryptionKeyMeta: { ...keys.encryptionMeta, keyId: keys.keyId, fingerprint: keys.keyFingerprint },
      authenticationKeyMeta: keys.authenticationMeta,
      maxLifetimeMs: params.maxLifetimeMs ?? this.maxLifetimeMs,
      idleTimeoutMs: params.idleTimeoutMs ?? this.idleTimeoutMs,
      metadata: params.metadata,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });

    await this.sessions.create(record);
    this.keyStore.store(record.sessionId, keys, sharedSecret);
    return this._activate(record);
  }

  /**
   * Register a Secure Session established on a device (DESCRIPTOR mode — server). The
   * device supplies PUBLIC key metadata (keyId, fingerprint, algorithm, length). No
   * keys are derived or stored here.
   *
   * @param {object} descriptor same shape as {@link establishSession} params but with
   *   `encryptionKeyMeta` / `authenticationKeyMeta` instead of `sharedSecret`.
   * @returns {Promise<object>} the public session DTO
   */
  async registerSession(descriptor) {
    this._validateParticipants(descriptor.participants);
    assertNoDuplicate(await this.sessions.findActiveByHandshake(descriptor.handshakeId));
    if (!descriptor.encryptionKeyMeta?.keyId) {
      throw new SessionValidationError("registerSession requires encryptionKeyMeta with a keyId");
    }
    const record = createSecureSession({
      sessionId: descriptor.sessionId,
      handshakeId: descriptor.handshakeId,
      participants: descriptor.participants,
      deviceIds: descriptor.deviceIds,
      protocolVersion: descriptor.protocolVersion ?? "1.0",
      encryptionKeyMeta: descriptor.encryptionKeyMeta,
      authenticationKeyMeta: descriptor.authenticationKeyMeta ?? { algorithm: "hmac-sha256", length: 32 },
      maxLifetimeMs: descriptor.maxLifetimeMs ?? this.maxLifetimeMs,
      idleTimeoutMs: descriptor.idleTimeoutMs ?? this.idleTimeoutMs,
      metadata: descriptor.metadata,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    await this.sessions.create(record);
    return this._activate(record);
  }

  // === queries =============================================================

  /**
   * Load a session, lazily expiring it (hard lifetime) or marking it idle (idle
   * timeout) as needed.
   * @param {string} sessionId @param {{ actingUser?: string }} [options]
   * @returns {Promise<object>} the public session DTO
   */
  async getSession(sessionId, options = {}) {
    validateSessionId(sessionId);
    let session = requireSession(await this.sessions.findById(sessionId), sessionId);
    if (options.actingUser) assertParticipant(session, options.actingUser);
    session = await this._refresh(session);
    return toPublicSession(session, { now: this.clock() });
  }

  /** Alias returning `{ valid, status, ... }`-style status; does the same refresh. */
  async getStatus(sessionId, options) {
    const dto = await this.getSession(sessionId, options);
    return { sessionId: dto.sessionId, status: dto.status, isActive: dto.isActive, isExpired: dto.isExpired, expiresAt: dto.expiresAt };
  }

  /** The active session for a handshake, or null. */
  async getActiveByHandshake(handshakeId) {
    const s = await this.sessions.findActiveByHandshake(handshakeId);
    return s ? toPublicSession(s, { now: this.clock() }) : null;
  }

  /** List the sessions a user participates in. */
  async listSessions(userId) {
    const records = await this.sessions.listByUser(userId);
    return records.map((s) => toPublicSession(s, { now: this.clock() }));
  }

  /** List sessions in a given lifecycle state. */
  async listByState(state) {
    return (await this.sessions.findByState(state)).map((s) => toPublicSession(s, { now: this.clock() }));
  }

  /**
   * Validate a session: shape, expiry, and (optionally) participant. Emits VALIDATED.
   * Marks the session INVALID on corrupted metadata.
   * @param {string} sessionId @param {{ actingUser?: string }} [options]
   * @returns {Promise<{ valid: boolean, status: string, reason?: string }>}
   */
  async validateSession(sessionId, options = {}) {
    validateSessionId(sessionId);
    const session = requireSession(await this.sessions.findById(sessionId), sessionId);
    try {
      validateMetadata(session);
    } catch (error) {
      if (error instanceof CorruptedMetadataError && !["invalid", "destroyed"].includes(session.status)) {
        await this._transition(session, SessionState.INVALID, { reason: SessionFailureReason.CORRUPTED_METADATA, event: SessionEventType.FAILED });
      }
      return { valid: false, status: SessionState.INVALID, reason: SessionFailureReason.CORRUPTED_METADATA };
    }
    if (options.actingUser) assertParticipant(session, options.actingUser);
    const refreshed = await this._refresh(session);
    const valid = refreshed.status === SessionState.ACTIVE || refreshed.status === SessionState.IDLE || refreshed.status === SessionState.RESUMED;
    this.events.emit(SessionEventType.VALIDATED, { sessionId, state: refreshed.status });
    return { valid, status: refreshed.status, reason: valid ? undefined : (isExpired(refreshed, this.clock()) ? SessionFailureReason.EXPIRED : SessionFailureReason.INVALID_STATE) };
  }

  // === lifecycle ===========================================================

  /** Record activity: refreshes the idle clock; wakes an IDLE session to ACTIVE. */
  async trackActivity(sessionId) {
    validateSessionId(sessionId);
    const session = requireSession(await this.sessions.findById(sessionId), sessionId);
    if (["closed", "destroyed", "invalid", "failed", "expired"].includes(session.status)) {
      throw new SessionValidationError(`Cannot track activity on a ${session.status} session`);
    }
    if (session.status === SessionState.IDLE) {
      return this._transition(session, SessionState.ACTIVE, { event: SessionEventType.ACTIVATED, patch: activityStamp(this.clock()) });
    }
    const updated = await this.sessions.update(sessionId, { ...activityStamp(this.clock()), updatedAt: new Date(this.clock()).toISOString() });
    return toPublicSession(updated, { now: this.clock() });
  }

  /** Mark an ACTIVE session IDLE. */
  async markIdle(sessionId) {
    const session = await this._require(sessionId);
    return this._transition(session, SessionState.IDLE, { reason: SessionFailureReason.IDLE_TIMEOUT, event: SessionEventType.IDLE });
  }

  /** Pause an active/idle session. */
  async pauseSession(sessionId) {
    const session = await this._require(sessionId);
    return this._transition(session, SessionState.PAUSED, { event: SessionEventType.PAUSED });
  }

  /**
   * Resume an idle/paused session (does NOT re-derive keys). If a resume `token` is
   * supplied it is verified against the device-local resumption key.
   * @param {string} sessionId @param {{ token?: string, actingUser?: string }} [options]
   */
  async resumeSession(sessionId, options = {}) {
    let session = await this._require(sessionId);
    if (options.actingUser) assertParticipant(session, options.actingUser);
    if (options.token) {
      if (!this.keyStore) throw new DeviceModeRequiredError("Verifying a resume token requires the device key store");
      const keys = this.keyStore.getKeys(sessionId);
      if (!keys) throw new DeviceModeRequiredError("No local keys to verify the resume token");
      const decoded = verifyResumeToken(options.token, keys.resumptionKey, { clock: this.clock });
      if (decoded.sessionId !== sessionId) throw new SessionValidationError("Resume token is for a different session");
    }
    // idle/paused → resumed → active
    session = await this._transition(session, SessionState.RESUMED, {
      event: SessionEventType.RESUMED,
      patch: { ...activityStamp(this.clock()), metadata: { ...(session.metadata ?? {}), ...resumeMetadata({ from: session.status, at: this.clock() }) } },
      returnRecord: true,
    });
    return this._transition(session, SessionState.ACTIVE, { event: SessionEventType.ACTIVATED });
  }

  /** Issue a resume token (DEVICE mode). */
  issueResumeToken(sessionId, options = {}) {
    if (!this.keyStore) throw new DeviceModeRequiredError("issueResumeToken requires the device key store");
    const keys = this.keyStore.getKeys(sessionId);
    if (!keys) throw new DeviceModeRequiredError("No local keys for this session");
    return issueResumeToken({
      sessionId,
      keyId: keys.keyId,
      generation: keys.generation,
      resumptionKey: keys.resumptionKey,
      ttlMs: options.ttlMs,
      clock: this.clock,
    });
  }

  /** Rotate a session's free-form metadata (never keys). */
  async rotateMetadata(sessionId, metadata) {
    const session = await this._require(sessionId);
    const updated = await this.sessions.update(sessionId, {
      metadata: { ...(session.metadata ?? {}), ...(metadata ?? {}) },
      updatedAt: new Date(this.clock()).toISOString(),
    });
    return toPublicSession(updated, { now: this.clock() });
  }

  /** Gracefully close a session (wipes device-local keys; retains metadata). */
  async closeSession(sessionId) {
    const session = await this._require(sessionId);
    const dto = await this._transition(session, SessionState.CLOSED, { event: SessionEventType.CLOSED });
    if (this.keyStore) this.keyStore.destroy(sessionId);
    return dto;
  }

  /** Destroy a session: wipe keys + delete the record. */
  async destroySession(sessionId) {
    validateSessionId(sessionId);
    const session = requireSession(await this.sessions.findById(sessionId), sessionId);
    if (session.status !== SessionState.DESTROYED) {
      assertTransition(session.status, SessionState.DESTROYED);
    }
    if (this.keyStore) this.keyStore.destroy(sessionId);
    await this.sessions.delete(sessionId);
    this.events.emit(SessionEventType.DESTROYED, { sessionId, handshakeId: session.handshakeId, previousState: session.status, state: SessionState.DESTROYED });
    return { sessionId, status: SessionState.DESTROYED, destroyed: true };
  }

  /** Expire a session (hard lifetime reached). */
  async expireSession(sessionId) {
    const session = await this._require(sessionId);
    return this._transition(session, SessionState.EXPIRED, { reason: SessionFailureReason.EXPIRED, event: SessionEventType.EXPIRED });
  }

  /**
   * Cleanup hook: expire all active sessions past their hard lifetime.
   * @returns {Promise<{ expired: number, sessionIds: string[] }>}
   */
  async sweepExpired() {
    const all = await this.sessions.listAll();
    const stale = selectExpired(all, this.clock());
    const sessionIds = [];
    for (const s of stale) {
      try {
        await this.expireSession(s.sessionId);
        sessionIds.push(s.sessionId);
      } catch {
        /* concurrently changed — skip */
      }
    }
    return { expired: sessionIds.length, sessionIds };
  }

  // === keys + rekey (device mode) =========================================

  /**
   * The device-local session keys (for a FUTURE encryption layer). NEVER exposed via
   * any API. @param {string} sessionId @returns {object} a {@link SessionKeys} bundle
   * @throws {DeviceModeRequiredError}
   */
  loadSessionKeys(sessionId) {
    if (!this.keyStore) throw new DeviceModeRequiredError("loadSessionKeys requires the device key store");
    const keys = this.keyStore.getKeys(sessionId);
    if (!keys) throw new DeviceModeRequiredError("No local keys for this session");
    return keys;
  }

  /**
   * Rekey a session using the rekey framework (DEVICE mode). Bumps the generation and
   * re-derives keys via the configured strategy. NOT forward-secret (Layer 5 extends
   * this via a ratchet strategy).
   * @param {string} sessionId @param {{ reason?: string, strategy?: string|Function }} [options]
   * @returns {Promise<object>} the public session DTO (new generation + keyId)
   */
  async rekey(sessionId, options = {}) {
    if (!this.keyStore) throw new DeviceModeRequiredError("rekey requires the device key store");
    const session = await this._require(sessionId);
    if (!canRekey(session)) throw new SessionValidationError(`Cannot rekey a ${session.status} session`);
    const currentKeys = this.keyStore.getKeys(sessionId);
    const sharedSecret = this.keyStore.getSharedSecret(sessionId);
    if (!currentKeys || !sharedSecret) throw new DeviceModeRequiredError("Missing local key material for rekey");

    const nextGeneration = (session.generation ?? 0) + 1;
    this.events.emit(SessionEventType.REKEY_REQUESTED, { sessionId, generation: nextGeneration, reason: options.reason });

    const strategy = resolveStrategy(options.strategy ?? this.rekeyStrategy);
    const newKeys = strategy({
      session,
      currentKeys,
      sharedSecret,
      nextGeneration,
      derivationContext: this._derivationContext(session),
    });
    this.keyStore.replaceKeys(sessionId, newKeys);

    const updated = await this.sessions.update(sessionId, {
      generation: nextGeneration,
      encryptionKey: { ...session.encryptionKey, keyId: newKeys.keyId, fingerprint: newKeys.keyFingerprint },
      rekeyHistory: [...(session.rekeyHistory ?? []), rekeyRecord({ generation: nextGeneration, reason: options.reason, strategy: typeof (options.strategy ?? this.rekeyStrategy) === "string" ? options.strategy ?? this.rekeyStrategy : "custom", at: this.clock() })],
      updatedAt: new Date(this.clock()).toISOString(),
    });
    this.events.emit(SessionEventType.REKEYED, { sessionId, generation: nextGeneration });
    return toPublicSession(updated, { now: this.clock() });
  }

  // === internals ==========================================================

  /** @private Load + require a session (validated id). */
  async _require(sessionId) {
    validateSessionId(sessionId);
    return requireSession(await this.sessions.findById(sessionId), sessionId);
  }

  /** @private CREATED → ACTIVE with the CREATED + ACTIVATED events. */
  async _activate(record) {
    this.events.emit(SessionEventType.CREATED, { sessionId: record.sessionId, handshakeId: record.handshakeId, state: record.status });
    return this._transition(record, SessionState.ACTIVE, { event: SessionEventType.ACTIVATED });
  }

  /**
   * @private Perform a guarded lifecycle transition, persisting status + history.
   * @returns {Promise<object|object>} the public DTO, or the raw record if `returnRecord`.
   */
  async _transition(session, toState, options = {}) {
    assertTransition(session.status, toState);
    const nowIso = new Date(this.clock()).toISOString();
    const patch = {
      status: toState,
      history: [...(session.history ?? []), { from: session.status, to: toState, at: nowIso, reason: options.reason }],
      updatedAt: nowIso,
      ...(options.patch ?? {}),
    };
    const updated = await this.sessions.update(session.sessionId, patch);
    if (options.event) {
      this.events.emit(options.event, {
        sessionId: session.sessionId,
        handshakeId: session.handshakeId,
        previousState: session.status,
        state: toState,
        reason: options.reason,
      });
    }
    return options.returnRecord ? updated : toPublicSession(updated, { now: this.clock() });
  }

  /** @private Lazily expire (hard lifetime) or idle-mark a session on read. */
  async _refresh(session) {
    const now = this.clock();
    if (["created", "active", "idle", "paused", "resumed"].includes(session.status) && isExpired(session, now)) {
      return this._transition(session, SessionState.EXPIRED, { reason: SessionFailureReason.EXPIRED, event: SessionEventType.EXPIRED, returnRecord: true });
    }
    if (shouldGoIdle(session, now)) {
      return this._transition(session, SessionState.IDLE, { reason: SessionFailureReason.IDLE_TIMEOUT, event: SessionEventType.IDLE, returnRecord: true });
    }
    return session;
  }

  /** @private */
  _derivationContext(session) {
    return {
      handshakeId: session.handshakeId,
      participants: session.participants,
      deviceIds: session.deviceIds,
      protocolVersion: session.protocolVersion,
    };
  }

  /** @private */
  _validateParticipants(participants) {
    if (!Array.isArray(participants) || participants.length !== 2) {
      throw new SessionValidationError("A session requires exactly two participants");
    }
    if (String(participants[0]) === String(participants[1])) {
      throw new SessionValidationError("Session participants must be distinct");
    }
  }
}

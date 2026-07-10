/**
 * @module session-integration/manager
 *
 * The **Application Session Manager** — the single entry point every messaging
 * operation uses to become session-aware. It composes the Sprint 3
 * {@link SecureSessionManager} (lifecycle), the Sprint 4 {@link SessionGuard}
 * (continuous validation), the {@link SessionContextRepository} (pair lookup + cache),
 * events, and metrics into one facade:
 *
 *   resolve → validate → (create-if-missing) → session context
 *
 * ## Enforcement
 * - `PERMISSIVE` (default): when there is no usable session, return a **fallback**
 *   context so messaging keeps working before every pair has a session; a
 *   handshake-fallback counter is bumped.
 * - `STRICT`: the context reports `resolved: false` / `HANDSHAKE_REQUIRED`; callers
 *   (middleware / pipeline) reject.
 *
 * @security Session AWARENESS only — no encryption. The context carries key METADATA
 * (keyId) never key bytes. `createIfMissing` cannot fabricate a secret server-side; in
 * descriptor mode it reports HANDSHAKE_REQUIRED (a device establishes the session).
 */

import { SessionResolution, TransportMode, EnforcementMode, IntegrationEventType } from "../types.js";
import { SessionContextRepository } from "../repositories/sessionContextRepository.js";
import { SessionIntegrationEventBus } from "../events/events.js";
import { MetricsCollector } from "../../shs/hardening/observability/metrics.js";

/** Integration metric names (stable strings for dashboards). */
export const IntegrationMetric = Object.freeze({
  RESOLVED: "integration.session.resolved",
  MISSING: "integration.session.missing",
  FAILURES: "integration.session.failures",
  FALLBACK: "integration.handshake.fallback",
  CREATED: "integration.session.created",
  LOOKUP_MS: "integration.session.lookup_ms",
  TRANSPORT_READY: "integration.transport.ready",
  ACTIVE: "integration.sessions.active",
});

/** Session statuses usable for messaging. */
const USABLE = new Set(["active", "idle", "resumed"]);

export class ApplicationSessionManager {
  /**
   * @param {object} deps
   * @param {object} deps.sessions a SecureSessionManager (Sprint 3)
   * @param {object} [deps.guard] a SessionGuard (Sprint 4) for continuous validation
   * @param {SessionContextRepository} [deps.repository]
   * @param {SessionIntegrationEventBus} [deps.events]
   * @param {MetricsCollector} [deps.metrics]
   * @param {string} [deps.enforcement="permissive"] one of {@link EnforcementMode}
   * @param {() => number} [deps.clock]
   */
  constructor(deps) {
    if (!deps || !deps.sessions) throw new Error("ApplicationSessionManager requires { sessions }");
    this.sessions = deps.sessions;
    this.guard = deps.guard ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.repository = deps.repository ?? new SessionContextRepository({ sessions: deps.sessions, clock: this.clock });
    this.events = deps.events ?? new SessionIntegrationEventBus();
    this.metrics = deps.metrics ?? new MetricsCollector();
    this.enforcement = deps.enforcement ?? EnforcementMode.PERMISSIVE;
  }

  // === resolution ==========================================================

  /** Resolve the active session bound to a pair, or null. */
  async resolveActiveSession(a, b) {
    return this.repository.findActiveByPair(a, b);
  }

  /** Load a single session by id (public DTO). */
  async loadSession(sessionId) {
    return this.sessions.getSession(sessionId);
  }

  /**
   * Validate a session for a caller. Uses the Sprint 4 SessionGuard when wired; else a
   * basic status/expiry/participant check.
   * @param {object} session a session DTO @param {string} actingUser
   * @returns {Promise<{ ok: boolean, expired: boolean, reasons: string[] }>}
   */
  async validateSession(session, actingUser) {
    if (this.guard) {
      const v = await this.guard.validate(session, { actingUser });
      return { ok: v.ok, expired: v.reasons.includes("expired"), reasons: v.reasons };
    }
    const reasons = [];
    if (!USABLE.has(session.status)) reasons.push(`status:${session.status}`);
    if (session.isExpired) reasons.push("expired");
    if (actingUser !== undefined && !(session.participants ?? []).map(String).includes(String(actingUser))) reasons.push("not-a-participant");
    return { ok: reasons.length === 0, expired: reasons.includes("expired"), reasons };
  }

  // === lifecycle passthroughs ==============================================

  /** Resume an idle/paused session; invalidates the pair cache. */
  async resumeSession(sessionId, actingUser) {
    const session = await this.sessions.resumeSession(sessionId, actingUser ? { actingUser } : {});
    this._invalidate(session);
    this.events.emit(IntegrationEventType.SESSION_RESUMED, { sessionId, initiator: actingUser });
    return session;
  }

  /** Close a session; invalidates the pair cache. */
  async closeSession(sessionId) {
    const session = await this.sessions.getSession(sessionId).catch(() => null);
    const closed = await this.sessions.closeSession(sessionId);
    if (session) this._invalidate(session);
    this.events.emit(IntegrationEventType.SESSION_CLOSED, { sessionId });
    return closed;
  }

  /** Record activity on a session (refreshes the idle clock). Best-effort. */
  async touch(sessionId) {
    try {
      return await this.sessions.trackActivity(sessionId);
    } catch {
      return null;
    }
  }

  /**
   * Return the existing active session for a pair, or create one if the underlying
   * manager is in device mode + a shared secret is supplied. In descriptor mode (the
   * server), a missing session cannot be fabricated — this reports HANDSHAKE_REQUIRED.
   *
   * @param {string} a @param {string} b
   * @param {{ handshakeId?: string, sharedSecret?: Buffer, deviceIds?: object, protocolVersion?: string }} [options]
   * @returns {Promise<{ created: boolean, session: object|null, resolution: string }>}
   */
  async createIfMissing(a, b, options = {}) {
    const existing = await this.resolveActiveSession(a, b);
    if (existing) return { created: false, session: existing, resolution: SessionResolution.RESOLVED };

    if (options.sharedSecret && typeof this.sessions.establishSession === "function") {
      try {
        const session = await this.sessions.establishSession({
          handshakeId: options.handshakeId ?? `hs-${a}-${b}`,
          participants: [String(a), String(b)],
          deviceIds: options.deviceIds,
          protocolVersion: options.protocolVersion,
          sharedSecret: options.sharedSecret,
        });
        this.repository.cacheForPair(a, b, session);
        this.metrics.increment(IntegrationMetric.CREATED);
        this.events.emit(IntegrationEventType.SESSION_CREATED, { sessionId: session.sessionId, initiator: a, peer: b });
        return { created: true, session, resolution: SessionResolution.RESOLVED };
      } catch {
        /* device mode required / establish failed → fall through to handshake-required */
      }
    }
    return { created: false, session: null, resolution: SessionResolution.HANDSHAKE_REQUIRED };
  }

  // === the consolidated session context ====================================

  /**
   * Resolve + validate the session between `actingUser` and `peer` and return the
   * {@link SessionContext} the middleware/pipeline attach. Never throws in PERMISSIVE
   * mode — it returns a fallback context and records the fallback.
   *
   * @param {string} actingUser @param {string} peer
   * @param {{ groupId?: string }} [options]
   * @returns {Promise<import("../types.js").SessionContext>}
   */
  async sessionContext(actingUser, peer, options = {}) {
    // Group messages are fan-out (no pairwise session in Sprint 5) → always fallback.
    if (options.groupId) {
      this.metrics.increment(IntegrationMetric.FALLBACK);
      this.events.emit(IntegrationEventType.PIPELINE_FALLBACK, { initiator: actingUser, details: { groupId: options.groupId } });
      return this._fallbackContext(actingUser, peer, SessionResolution.MISSING, null, { groupId: options.groupId });
    }

    const start = this.clock();
    const session = await this.resolveActiveSession(actingUser, peer);
    this.metrics.observe(IntegrationMetric.LOOKUP_MS, this.clock() - start);

    if (!session) {
      this.metrics.increment(IntegrationMetric.MISSING);
      this.metrics.increment(IntegrationMetric.FALLBACK);
      this.events.emit(IntegrationEventType.SESSION_MISSING, { initiator: actingUser, peer });
      return this._fallbackContext(actingUser, peer, SessionResolution.HANDSHAKE_REQUIRED);
    }

    const verdict = await this.validateSession(session, actingUser);
    if (!verdict.ok) {
      this.metrics.increment(IntegrationMetric.FAILURES);
      this.metrics.increment(IntegrationMetric.FALLBACK);
      const resolution = verdict.expired ? SessionResolution.EXPIRED : SessionResolution.INVALID;
      this.events.emit(verdict.expired ? IntegrationEventType.SESSION_EXPIRED : IntegrationEventType.SESSION_MISSING, {
        sessionId: session.sessionId,
        initiator: actingUser,
        peer,
        details: { reasons: verdict.reasons },
      });
      this.repository.invalidatePair(actingUser, peer);
      return this._fallbackContext(actingUser, peer, resolution, session);
    }

    this.metrics.increment(IntegrationMetric.RESOLVED);
    this.events.emit(IntegrationEventType.SESSION_RESOLVED, { sessionId: session.sessionId, initiator: actingUser, peer });
    this.events.emit(IntegrationEventType.SESSION_VALIDATED, { sessionId: session.sessionId, initiator: actingUser, peer });
    return {
      resolution: SessionResolution.RESOLVED,
      resolved: true,
      transportMode: TransportMode.SESSION,
      fallback: false,
      sessionId: session.sessionId,
      handshakeId: session.handshakeId,
      keyId: session.encryptionKey?.keyId ?? null,
      status: session.status,
      participants: session.participants,
      warnings: [],
      initiator: String(actingUser),
      peer: String(peer),
    };
  }

  /** Whether a context should be rejected under the current enforcement policy. */
  shouldReject(context) {
    return this.enforcement === EnforcementMode.STRICT && !context.resolved;
  }

  // === stats ===============================================================

  /**
   * Consolidated integration statistics (metrics snapshot + repository/cache stats +
   * active-session gauge).
   * @returns {Promise<object>}
   */
  async getStats() {
    // Best-effort active-session gauge from the underlying manager.
    let active = null;
    try {
      const list = await this.sessions.listByState("active");
      active = list.length;
      this.metrics.gauge(IntegrationMetric.ACTIVE, active);
    } catch {
      /* listByState may be unavailable in some wirings */
    }
    return {
      enforcement: this.enforcement,
      activeSessions: active,
      repository: this.repository.stats(),
      metrics: this.metrics.snapshot(),
    };
  }

  // === internals ===========================================================

  /** @private */
  _fallbackContext(actingUser, peer, resolution, session = null, extraMeta = {}) {
    return {
      resolution,
      resolved: false,
      transportMode: TransportMode.FALLBACK,
      fallback: true,
      sessionId: session?.sessionId ?? null,
      handshakeId: session?.handshakeId ?? null,
      keyId: null,
      status: session?.status ?? null,
      participants: session?.participants ?? [String(actingUser), String(peer)].filter(Boolean),
      warnings: [{ type: resolution, message: `No usable secure session (${resolution})` }],
      initiator: String(actingUser),
      peer: peer ? String(peer) : null,
      ...extraMeta,
    };
  }

  /** @private */
  _invalidate(session) {
    const parts = (session?.participants ?? []).map(String);
    if (parts.length === 2) this.repository.invalidatePair(parts[0], parts[1]);
  }
}

/**
 * @module session-integration/middleware
 *
 * Reusable Express middleware that makes a route session-aware. Built by
 * {@link createSessionMiddleware} around an {@link ApplicationSessionManager}. All
 * middleware attach a {@link SessionContext} to `req.sessionContext` and are safe to
 * chain.
 *
 * - **resolveSession** — resolve + attach the session context (never blocks).
 * - **requireSession** — in STRICT mode, reject when no valid session (428); no-op in
 *   PERMISSIVE (the fallback path handles it).
 * - **validateSession** — reject an expired/invalid session in STRICT mode (410/409).
 * - **refreshSession** — record activity on the resolved session (best-effort).
 * - **rejectInvalidSession** — combined guard for endpoints that opt into strictness.
 *
 * Future ENCRYPTION middleware plugs in right after `resolveSession` — the context +
 * envelope hooks are already here.
 *
 * @security These middleware add awareness/validation only. In PERMISSIVE mode they
 * never break existing messaging; they annotate the request and record metrics.
 */

import { EnforcementMode, SessionResolution, IntegrationEventType } from "../types.js";
import { HandshakeRequiredError, SessionUnavailableError } from "../errors.js";

/**
 * Build the middleware set for a route.
 * @param {object} deps
 * @param {import("../manager/applicationSessionManager.js").ApplicationSessionManager} deps.appSessions
 * @param {string} [deps.peerParam="id"] the route param holding the counterparty user id
 * @returns {{ resolveSession: Function, requireSession: Function, validateSession: Function, refreshSession: Function, rejectInvalidSession: Function }}
 *
 * @example
 * ```js
 * const { resolveSession, refreshSession } = createSessionMiddleware({ appSessions });
 * messageRouter.post("/send/:id", protectedRoute, resolveSession, refreshSession, sendMessage);
 * ```
 */
export function createSessionMiddleware(deps) {
  const app = deps.appSessions;
  const peerParam = deps.peerParam ?? "id";

  const peerOf = (req) => req.params?.[peerParam] ?? req.body?.recipientId ?? null;
  const userOf = (req) => (req.user ? String(req.user._id) : null);

  /** Resolve + attach the session context. Never blocks. */
  async function resolveSession(req, res, next) {
    try {
      const peer = peerOf(req);
      const groupId = req.params?.groupId ?? req.body?.groupId ?? null;
      req.sessionContext = await app.sessionContext(userOf(req), peer, groupId ? { groupId } : {});
      next();
    } catch (error) {
      // Resolution must never break a request in this layer — attach a null context.
      req.sessionContext = null;
      next();
    }
  }

  /** In STRICT mode, require a valid session; otherwise pass through. */
  function requireSession(req, res, next) {
    const ctx = req.sessionContext;
    if (app.enforcement === EnforcementMode.STRICT && (!ctx || !ctx.resolved)) {
      app.events.emit(IntegrationEventType.PIPELINE_REJECTED, { initiator: userOf(req), details: { reason: SessionResolution.HANDSHAKE_REQUIRED } });
      const err = new HandshakeRequiredError();
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    next();
  }

  /** In STRICT mode, reject an expired/invalid resolved session. */
  function validateSession(req, res, next) {
    const ctx = req.sessionContext;
    if (app.enforcement === EnforcementMode.STRICT && ctx && !ctx.resolved && ctx.resolution !== SessionResolution.HANDSHAKE_REQUIRED) {
      const err = new SessionUnavailableError(`Session ${ctx.resolution}`, { details: { resolution: ctx.resolution } });
      return res.status(err.status).json({ success: false, code: err.code, message: err.message, recovery: "resume-or-rehandshake" });
    }
    next();
  }

  /** Record activity on the resolved session (best-effort, non-blocking). */
  async function refreshSession(req, res, next) {
    const ctx = req.sessionContext;
    if (ctx?.sessionId) {
      app.touch(ctx.sessionId).catch(() => {});
    }
    next();
  }

  /** Combined strict guard: require + validate. */
  function rejectInvalidSession(req, res, next) {
    return requireSession(req, res, () => validateSession(req, res, next));
  }

  return { resolveSession, requireSession, validateSession, refreshSession, rejectInvalidSession };
}

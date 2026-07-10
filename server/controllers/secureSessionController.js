/**
 * @module controllers/secureSessionController
 *
 * HTTP handlers for Secure Sessions (Layer 4, Sprint 3). The server runs the
 * {@link SecureSessionManager} in **descriptor mode** — it tracks session lifecycle
 * METADATA a device established locally. It NEVER derives, holds, or returns session
 * keys, MAC keys, private keys, or shared secrets.
 *
 * Sessions are bound to a completed handshake: `/register` looks up the SHS handshake
 * session to derive the true participants/devices (never trusted from the body) and
 * requires the handshake to be `cryptographically_complete` (Sprint 2). All routes
 * sit behind the existing `protectedRoute` (JWT).
 */

import { SecureSessionManager } from "../shs/session/manager/sessionManager.js";
import { createMongoSessionRepository } from "../shs/session/repository/mongoRepository.js";
import { SessionError } from "../shs/session/errors.js";
import { SessionEventBus } from "../shs/session/events/events.js";
import { createMongoShsRepository } from "../shs/repository/mongoRepository.js";

const { sessions: shsSessions } = createMongoShsRepository();

/** Shared event bus — future layers (Layer 5 messaging) subscribe here. */
export const secureSessionEvents = new SessionEventBus();

const sessionManager = new SecureSessionManager({
  ...createMongoSessionRepository(),
  events: secureSessionEvents,
  // No keyStore → descriptor mode: the server cannot derive or hold keys.
});

export { sessionManager };

function handleError(res, error, where) {
  if (error instanceof SessionError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

const callerId = (req) => String(req.user._id);

/** Load the SHS handshake and confirm the caller is a party + it is crypto-complete. */
async function resolveHandshake(req, res, handshakeId) {
  const handshake = await shsSessions.findById(handshakeId);
  if (!handshake) {
    res.status(404).json({ success: false, code: "ERR_SHS_NOT_FOUND", message: "Handshake not found" });
    return null;
  }
  const me = callerId(req);
  if (String(handshake.initiator) !== me && String(handshake.responder) !== me) {
    res.status(403).json({ success: false, code: "ERR_SESSION_PARTICIPANT_MISMATCH", message: "Not a party to this handshake" });
    return null;
  }
  return handshake;
}

/**
 * POST /api/secure-session/register — register a session established on-device.
 * Body: { handshakeId, sessionId?, encryptionKey:{algorithm,length,keyId,fingerprint},
 *         authenticationKey?, protocolVersion?, maxLifetimeMs?, idleTimeoutMs?, metadata? }
 */
export const registerSession = async (req, res) => {
  try {
    const body = req.body ?? {};
    const handshake = await resolveHandshake(req, res, body.handshakeId);
    if (!handshake) return;
    if (handshake.state !== "cryptographically_complete") {
      return res.status(409).json({ success: false, code: "ERR_SESSION_VALIDATION", message: "Handshake has no established shared secret yet" });
    }
    const session = await sessionManager.registerSession({
      handshakeId: body.handshakeId,
      sessionId: body.sessionId,
      participants: [String(handshake.initiator), String(handshake.responder)],
      deviceIds: { initiator: handshake.initiatorDevice, responder: handshake.responderDevice },
      protocolVersion: body.protocolVersion ?? handshake.protocolVersion,
      encryptionKeyMeta: body.encryptionKey,
      authenticationKeyMeta: body.authenticationKey,
      maxLifetimeMs: body.maxLifetimeMs,
      idleTimeoutMs: body.idleTimeoutMs,
      metadata: body.metadata,
    });
    return res.status(201).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "registerSession");
  }
};

/** GET /api/secure-session — list the caller's sessions. */
export const listSessions = async (req, res) => {
  try {
    let sessions = await sessionManager.listSessions(callerId(req));
    if (req.query?.status) sessions = sessions.filter((s) => s.status === req.query.status);
    return res.status(200).json({ success: true, sessions });
  } catch (error) {
    return handleError(res, error, "listSessions");
  }
};

/** GET /api/secure-session/handshake/:handshakeId — active session for a handshake. */
export const getActiveByHandshake = async (req, res) => {
  try {
    const handshake = await resolveHandshake(req, res, req.params.handshakeId);
    if (!handshake) return;
    const session = await sessionManager.getActiveByHandshake(req.params.handshakeId);
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "getActiveByHandshake");
  }
};

/** GET /api/secure-session/:sessionId — session status (caller must be a participant). */
export const getSession = async (req, res) => {
  try {
    const session = await sessionManager.getSession(req.params.sessionId, { actingUser: callerId(req) });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "getSession");
  }
};

/** GET /api/secure-session/:sessionId/status — compact status. */
export const getStatus = async (req, res) => {
  try {
    const status = await sessionManager.getStatus(req.params.sessionId, { actingUser: callerId(req) });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** POST /api/secure-session/:sessionId/resume — resume an idle/paused session. */
export const resumeSession = async (req, res) => {
  try {
    const session = await sessionManager.resumeSession(req.params.sessionId, { actingUser: callerId(req) });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "resumeSession");
  }
};

/** POST /api/secure-session/:sessionId/activity — record activity. */
export const trackActivity = async (req, res) => {
  try {
    // Ensure the caller participates before touching activity.
    await sessionManager.getSession(req.params.sessionId, { actingUser: callerId(req) });
    const session = await sessionManager.trackActivity(req.params.sessionId);
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "trackActivity");
  }
};

/** POST /api/secure-session/:sessionId/close — gracefully close a session. */
export const closeSession = async (req, res) => {
  try {
    await sessionManager.getSession(req.params.sessionId, { actingUser: callerId(req) });
    const session = await sessionManager.closeSession(req.params.sessionId);
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "closeSession");
  }
};

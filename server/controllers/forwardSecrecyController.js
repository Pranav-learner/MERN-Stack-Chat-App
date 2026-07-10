/**
 * @module controllers/forwardSecrecyController
 *
 * HTTP handlers for the **Forward Secrecy Engine** (Layer 5, Sprint 2). The server runs
 * the {@link ForwardSecrecyManager} in **descriptor mode** — it tracks forward-secrecy
 * generation METADATA (current generation, per-generation key ids / fingerprints /
 * statuses, destruction records, audit) that devices report. It NEVER derives, holds, or
 * returns a chain secret, session key, or shared secret — the actual key evolution and
 * destruction happen on-device.
 *
 * Endpoints: read-only status/history/audit, plus authenticated device REPORT endpoints
 * (`/start`, `/evolve`) that record metadata a device produced locally. All routes sit
 * behind the existing `protectedRoute` (JWT) and enforce session participation via the
 * Secure Session manager.
 */

import { ForwardSecrecyManager } from "../forward-secrecy/manager/forwardSecrecyManager.js";
import { createMongoForwardSecrecyRepository } from "../forward-secrecy/repository/mongoForwardSecrecyRepository.js";
import { ForwardSecrecyEventBus } from "../forward-secrecy/events/events.js";
import { ForwardSecrecyError } from "../forward-secrecy/errors.js";
import { sessionManager } from "./secureSessionController.js";
import { evolutionManager } from "./sessionEvolutionController.js";

/** Shared FS event bus — future Layer 5 sprints (chain/message keys) subscribe here. */
export const forwardSecrecyEvents = new ForwardSecrecyEventBus();

/**
 * Descriptor-mode FS manager (metadata only; no keyStore → cannot derive/hold keys).
 * Bridged to the Sprint 1 evolution manager so device-reported evolutions also advance
 * the evolution generation metadata.
 */
export const forwardSecrecyManager = new ForwardSecrecyManager({
  ...createMongoForwardSecrecyRepository(),
  events: forwardSecrecyEvents,
  evolution: evolutionManager,
});

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof ForwardSecrecyError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** Confirm the caller participates in the session; returns the session DTO or null (writes the error). */
async function authorizeSession(req, res, sessionId) {
  try {
    return await sessionManager.getSession(sessionId, { actingUser: callerId(req) });
  } catch (error) {
    if (error?.status) res.status(error.status).json({ success: false, code: error.code, message: error.message });
    else res.status(500).json({ success: false, message: "Internal Server Error" });
    return null;
  }
}

/**
 * POST /api/forward-secrecy/:sessionId/start — record that a device started forward
 * secrecy (generation 0). Body: { keyId?, fingerprint? }. NO key material is accepted.
 */
export const startForwardSecrecy = async (req, res) => {
  try {
    const session = await authorizeSession(req, res, req.params.sessionId);
    if (!session) return;
    const state = await forwardSecrecyManager.register({
      sessionId: req.params.sessionId,
      handshakeId: session.handshakeId,
      participants: session.participants,
      keyId: req.body?.keyId,
      fingerprint: req.body?.fingerprint,
    });
    return res.status(201).json({ success: true, forwardSecrecy: state });
  } catch (error) {
    return handleError(res, error, "startForwardSecrecy");
  }
};

/**
 * POST /api/forward-secrecy/:sessionId/evolve — record a device-performed evolution.
 * Body: { generation, keyId?, fingerprint?, trigger?, reason? }. NO key material accepted.
 */
export const reportEvolution = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const body = req.body ?? {};
    const state = await forwardSecrecyManager.recordEvolution(req.params.sessionId, {
      generation: body.generation,
      keyId: body.keyId,
      fingerprint: body.fingerprint,
      trigger: body.trigger,
      reason: body.reason,
    });
    return res.status(200).json({ success: true, forwardSecrecy: state });
  } catch (error) {
    return handleError(res, error, "reportEvolution");
  }
};

/** GET /api/forward-secrecy/:sessionId — full forward-secrecy state (metadata only). */
export const getForwardSecrecyState = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const forwardSecrecy = await forwardSecrecyManager.getState(req.params.sessionId);
    return res.status(200).json({ success: true, forwardSecrecy });
  } catch (error) {
    return handleError(res, error, "getForwardSecrecyState");
  }
};

/** GET /api/forward-secrecy/:sessionId/status — compact current-generation status. */
export const getForwardSecrecyStatus = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const status = await forwardSecrecyManager.getStatus(req.params.sessionId);
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getForwardSecrecyStatus");
  }
};

/** GET /api/forward-secrecy/:sessionId/history — the generation metadata history. */
export const getGenerationHistory = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const generations = await forwardSecrecyManager.getHistory(req.params.sessionId);
    return res.status(200).json({ success: true, generations });
  } catch (error) {
    return handleError(res, error, "getGenerationHistory");
  }
};

/** GET /api/forward-secrecy/:sessionId/audit — the security audit trail (metadata only). */
export const getForwardSecrecyAudit = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const audit = await forwardSecrecyManager.getAudit(req.params.sessionId);
    return res.status(200).json({ success: true, audit });
  } catch (error) {
    return handleError(res, error, "getForwardSecrecyAudit");
  }
};

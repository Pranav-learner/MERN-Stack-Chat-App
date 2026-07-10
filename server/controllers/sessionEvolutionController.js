/**
 * @module controllers/sessionEvolutionController
 *
 * HTTP handlers for the **Session Evolution Framework** (Layer 5, Sprint 1). These are
 * READ-ONLY, evolution-AWARENESS endpoints: they expose that a Secure Session has a
 * generation, an evolution state, attached policies, and metadata. They perform NO key
 * rotation and NO cryptography.
 *
 * The server runs the {@link EvolutionManager} with a Mongo repository and bridges it to
 * the {@link module:controllers/secureSessionController secure-session event bus}, so an
 * evolution record is created/retired automatically as sessions come and go. Every route
 * sits behind the existing `protectedRoute` (JWT) and enforces that the caller is a
 * participant of the underlying session (via the Secure Session manager).
 */

import { EvolutionManager } from "../session-evolution/manager/evolutionManager.js";
import { createMongoEvolutionRepository } from "../session-evolution/repository/mongoEvolutionRepository.js";
import { EvolutionEventBus } from "../session-evolution/events/events.js";
import { attachSessionEvolution } from "../session-evolution/integration/sessionEvolutionBridge.js";
import { EvolutionError } from "../session-evolution/errors.js";
import { sessionManager, secureSessionEvents } from "./secureSessionController.js";

/** Shared evolution event bus — future Layer 5 sprints subscribe here. */
export const evolutionEvents = new EvolutionEventBus();

/** Descriptor-mode evolution manager (metadata only; no keys, no crypto). */
export const evolutionManager = new EvolutionManager({
  ...createMongoEvolutionRepository(),
  events: evolutionEvents,
});

// Make the chat backend evolution-aware: mirror session lifecycle → evolution records.
attachSessionEvolution({ sessionEvents: secureSessionEvents, evolutionManager });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof EvolutionError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * Confirm the caller participates in the session backing an evolution record. Returns
 * the session DTO, or null (and writes the response) on failure.
 */
async function authorizeSession(req, res, sessionId) {
  try {
    return await sessionManager.getSession(sessionId, { actingUser: callerId(req) });
  } catch (error) {
    if (error?.status) res.status(error.status).json({ success: false, code: error.code, message: error.message });
    else res.status(500).json({ success: false, message: "Internal Server Error" });
    return null;
  }
}

/** GET /api/session-evolution/:sessionId — the evolution record for a session. */
export const getEvolutionState = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const evolution = await evolutionManager.getEvolutionState(req.params.sessionId);
    return res.status(200).json({ success: true, evolution });
  } catch (error) {
    return handleError(res, error, "getEvolutionState");
  }
};

/** GET /api/session-evolution/:sessionId/status — compact generation status. */
export const getEvolutionStatus = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const status = await evolutionManager.getStatus(req.params.sessionId);
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getEvolutionStatus");
  }
};

/** GET /api/session-evolution/:sessionId/metadata — the metadata framework bundle. */
export const getEvolutionMetadata = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const metadata = await evolutionManager.getMetadata(req.params.sessionId);
    return res.status(200).json({ success: true, metadata });
  } catch (error) {
    return handleError(res, error, "getEvolutionMetadata");
  }
};

/** GET /api/session-evolution/:sessionId/history — the generation timeline snapshot. */
export const getGenerationHistory = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const timeline = await evolutionManager.getMigrationSnapshot(req.params.sessionId);
    return res.status(200).json({ success: true, timeline });
  } catch (error) {
    return handleError(res, error, "getGenerationHistory");
  }
};

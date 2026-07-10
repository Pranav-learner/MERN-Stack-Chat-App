/**
 * @module controllers/keyHierarchyController
 *
 * HTTP handlers for the **Key Hierarchy** subsystem (Layer 5, Sprint 4). The server exposes
 * per-session hierarchy METADATA — the root-key + chain ids / fingerprints / generations /
 * indexes / statuses that a device established locally. The actual Root Key + chain keys are
 * device-local (never leave the device), so the server-side manager runs WITHOUT a key store
 * (descriptor mode): read-only.
 *
 * All routes sit behind `protectedRoute` (JWT) and enforce session participation.
 */

import { ChainManager } from "../key-hierarchy/manager/chainManager.js";
import { createMongoKeyHierarchyRepository } from "../key-hierarchy/repository/mongoKeyHierarchyRepository.js";
import { KeyHierarchyEventBus } from "../key-hierarchy/events/events.js";
import { KeyHierarchyError } from "../key-hierarchy/errors.js";
import { sessionManager } from "./secureSessionController.js";

/** Shared key-hierarchy event bus — future Sprint 5 (message keys) subscribes here. */
export const keyHierarchyEvents = new KeyHierarchyEventBus();

/** Descriptor-mode chain manager (no keyStore → tracks metadata, holds no keys). */
export const chainManager = new ChainManager({
  ...createMongoKeyHierarchyRepository(),
  events: keyHierarchyEvents,
});

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof KeyHierarchyError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

async function authorizeSession(req, res, sessionId) {
  try {
    return await sessionManager.getSession(sessionId, { actingUser: callerId(req) });
  } catch (error) {
    if (error?.status) res.status(error.status).json({ success: false, code: error.code, message: error.message });
    else res.status(500).json({ success: false, message: "Internal Server Error" });
    return null;
  }
}

/** GET /api/key-hierarchy/:sessionId — full hierarchy (metadata only). */
export const getHierarchy = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const hierarchy = await chainManager.getState(req.params.sessionId);
    return res.status(200).json({ success: true, hierarchy });
  } catch (error) {
    return handleError(res, error, "getHierarchy");
  }
};

/** GET /api/key-hierarchy/:sessionId/status — compact status. */
export const getStatus = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const status = await chainManager.getStatus(req.params.sessionId);
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/key-hierarchy/:sessionId/chains — sending + receiving chain metadata. */
export const getChains = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const [sending, receiving] = await Promise.all([
      chainManager.getSendingChain(req.params.sessionId),
      chainManager.getReceivingChain(req.params.sessionId),
    ]);
    return res.status(200).json({ success: true, chains: { sending, receiving } });
  } catch (error) {
    return handleError(res, error, "getChains");
  }
};

/** GET /api/key-hierarchy/:sessionId/root — root-key metadata. */
export const getRootKey = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const root = await chainManager.getRootKey(req.params.sessionId);
    return res.status(200).json({ success: true, root });
  } catch (error) {
    return handleError(res, error, "getRootKey");
  }
};

/** GET /api/key-hierarchy/:sessionId/audit — audit trail. */
export const getAudit = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const audit = await chainManager.getAudit(req.params.sessionId);
    return res.status(200).json({ success: true, audit });
  } catch (error) {
    return handleError(res, error, "getAudit");
  }
};

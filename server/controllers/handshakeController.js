/**
 * @module controllers/handshakeController
 *
 * HTTP handlers for the Secure Handshake System (Layer 4, Sprint 1). Thin adapters
 * over the {@link HandshakeManager}. They establish NO shared secrets and touch no
 * private keys; they drive the handshake PROTOCOL lifecycle only. All routes sit
 * behind the existing `protectedRoute` (JWT) middleware — SHS is additive.
 *
 * The manager is wired with the Layer 3 directories so it can reject handshakes to
 * unknown identities / from unknown devices:
 *  - `identityLookup` → Sprint 1 IdentityManager
 *  - `deviceLookup`   → Sprint 2 DeviceManager
 */

import { HandshakeManager } from "../shs/manager/handshakeManager.js";
import { createMongoShsRepository } from "../shs/repository/mongoRepository.js";
import { ShsError } from "../shs/errors.js";
import { HandshakeEventBus } from "../shs/events/events.js";
import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { IdentityError } from "../identity/errors.js";
import { DeviceManager } from "../device-trust/manager/deviceManager.js";
import { createMongoDeviceRepository } from "../device-trust/repository/mongoRepository.js";

const identityManager = new IdentityManager(createMongoRepositories());
const { devices: deviceRepo } = createMongoDeviceRepository();
const deviceManager = new DeviceManager({ devices: deviceRepo });

/** Shared event bus — future layers (and telemetry) subscribe here. */
export const handshakeEvents = new HandshakeEventBus();

const handshakeManager = new HandshakeManager({
  ...createMongoShsRepository(),
  events: handshakeEvents,
  identityLookup: (userId) => identityManager.getIdentityByUser(userId),
  deviceLookup: async (userId, deviceId) => {
    try {
      return await deviceManager.getDevice(userId, deviceId);
    } catch {
      return null;
    }
  },
});

export { handshakeManager };

function handleError(res, error, where) {
  if (error instanceof ShsError || error instanceof IdentityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** Ensure the caller is a party to the session, else 403 (defence in depth over ownership). */
function callerId(req) {
  return String(req.user._id);
}

/** POST /api/handshake/start — Body: { responderId, initiatorDevice, responderDevice?, version?, capabilities?, metadata? } */
export const startHandshake = async (req, res) => {
  try {
    const { responderId, initiatorDevice, responderDevice, version, capabilities, metadata } = req.body ?? {};
    const result = await handshakeManager.startHandshake({
      initiator: callerId(req),
      responder: responderId,
      initiatorDevice,
      responderDevice,
      version,
      capabilities,
      metadata,
    });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "startHandshake");
  }
};

/** POST /api/handshake/:id/accept — Body: { responderDevice?, version?, capabilities? } */
export const acceptHandshake = async (req, res) => {
  try {
    const { responderDevice, version, capabilities } = req.body ?? {};
    const result = await handshakeManager.acceptHandshake(req.params.id, callerId(req), {
      responderDevice,
      version,
      capabilities,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "acceptHandshake");
  }
};

/** POST /api/handshake/:id/complete */
export const completeHandshake = async (req, res) => {
  try {
    const result = await handshakeManager.completeHandshake(req.params.id, callerId(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "completeHandshake");
  }
};

/** POST /api/handshake/:id/reject — Body: { reason? } */
export const rejectHandshake = async (req, res) => {
  try {
    const result = await handshakeManager.rejectHandshake(req.params.id, callerId(req), req.body?.reason);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "rejectHandshake");
  }
};

/** POST /api/handshake/:id/cancel — Body: { reason? } */
export const cancelHandshake = async (req, res) => {
  try {
    const result = await handshakeManager.cancelHandshake(req.params.id, callerId(req), req.body?.reason);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "cancelHandshake");
  }
};

/** POST /api/handshake/:id/resume */
export const resumeHandshake = async (req, res) => {
  try {
    const result = await handshakeManager.resumeHandshake(req.params.id, callerId(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resumeHandshake");
  }
};

/** POST /api/handshake/:id/restart */
export const restartHandshake = async (req, res) => {
  try {
    const result = await handshakeManager.restartHandshake(req.params.id, callerId(req));
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "restartHandshake");
  }
};

/** GET /api/handshake/:id — status of a single handshake (caller must be a party). */
export const getHandshake = async (req, res) => {
  try {
    const session = await handshakeManager.getHandshake(req.params.id, { actingUser: callerId(req) });
    if (session.initiator !== callerId(req) && session.responder !== callerId(req)) {
      return res.status(403).json({ success: false, code: "ERR_SHS_OWNERSHIP", message: "Not a party to this handshake" });
    }
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "getHandshake");
  }
};

/** GET /api/handshake — list the caller's handshake sessions (optional ?state=). */
export const listSessions = async (req, res) => {
  try {
    let sessions = await handshakeManager.listSessions(callerId(req));
    if (req.query?.state) sessions = sessions.filter((s) => s.state === req.query.state);
    return res.status(200).json({ success: true, sessions });
  } catch (error) {
    return handleError(res, error, "listSessions");
  }
};

/** GET /api/handshake/protocol/info — advertised protocol version + capabilities. */
export const getProtocolInfo = async (_req, res) => {
  try {
    const { versionDescriptor } = await import("../shs/protocol/version.js");
    return res.status(200).json({ success: true, protocol: versionDescriptor() });
  } catch (error) {
    return handleError(res, error, "getProtocolInfo");
  }
};

/**
 * @module controllers/pdpController
 *
 * HTTP handlers for the **Peer Discovery Protocol (PDP)** (Layer 6, Sprint 4), mounted at
 * `/api/pdp`. This is the Express BINDING of the transport-independent
 * {@link module:pdp/api PDP API facade}. It composes the three singleton subsystem managers
 * (Discovery, Presence, Capabilities) from their controllers under one PeerDiscoveryManager, so PDP
 * orchestrates exactly the same live subsystems the other APIs serve.
 *
 * PDP produces a validated **connection plan** — WHO to connect to + HOW — and establishes NOTHING
 * (no NAT traversal, ICE, WebRTC, sockets; that is Layer 7). Every route sits behind the EXISTING
 * `protectedRoute` JWT middleware; the authenticated `req.user._id` is the discovery requester.
 *
 * @security These endpoints only ever return PUBLIC control-plane metadata — ids, public
 * identities, presence status, negotiated versions/transports/flags. They never accept or return a
 * private key, session key, message key, chain key, or shared secret.
 */

import { PeerDiscoveryManager } from "../peer-discovery-protocol/manager/peerDiscoveryManager.js";
import { createPdpApi } from "../peer-discovery-protocol/api/pdpApi.js";
import { createMongoPdpRepository } from "../peer-discovery-protocol/repositories/mongoPdpRepository.js";
import { PdpEventBus } from "../peer-discovery-protocol/events/events.js";
import { PdpError } from "../peer-discovery-protocol/errors.js";
import { discoveryManager } from "./discoveryController.js";
import { presenceManager } from "./presenceController.js";
import { capabilityManager } from "./capabilityController.js";

/**
 * Shared PDP event bus. Future Layer 7 (NAT Traversal) subscribes here to consume connection plans
 * as they are produced.
 */
export const pdpEvents = new PdpEventBus();

/** Process-wide Peer Discovery Manager: orchestrates the live Discovery/Presence/Capability managers. */
export const peerDiscoveryManager = new PeerDiscoveryManager({
  discovery: discoveryManager,
  presence: presenceManager,
  capabilities: capabilityManager,
  ...createMongoPdpRepository(),
  events: pdpEvents,
});

/** The stable, transport-independent facade the HTTP handlers delegate to. */
export const pdpApi = createPdpApi(peerDiscoveryManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof PdpError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/pdp/discover — start a discovery run → returns the session + connection plan.
 * Body: { requesterDevice, targetUser, targetDevices?, selectionPolicy?, transportPolicy?,
 *         selectionOptions?, maxDevices?, ttlMs?, useCache? }.
 */
export const startDiscovery = async (req, res) => {
  try {
    const outcome = await pdpApi.startDiscovery({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, ...outcome });
  } catch (error) {
    return handleError(res, error, "startDiscovery");
  }
};

/** GET /api/pdp/:discoveryId — full discovery-session view (`?audit=true`). */
export const getDiscovery = async (req, res) => {
  try {
    const session = await pdpApi.getDiscovery({ actingUser: callerId(req), discoveryId: req.params.discoveryId, includeAudit: req.query.audit === "true" });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "getDiscovery");
  }
};

/** GET /api/pdp/:discoveryId/status — compact status (for polling). */
export const getStatus = async (req, res) => {
  try {
    const status = await pdpApi.getStatus({ actingUser: callerId(req), discoveryId: req.params.discoveryId });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/pdp/:discoveryId/plan — the connection plan produced by a discovery run. */
export const getConnectionPlan = async (req, res) => {
  try {
    const result = await pdpApi.getConnectionPlan({ actingUser: callerId(req), discoveryId: req.params.discoveryId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getConnectionPlan");
  }
};

/** GET /api/pdp/plan/:planId — a connection plan by its planId. */
export const getPlan = async (req, res) => {
  try {
    const result = await pdpApi.getPlan({ actingUser: callerId(req), planId: req.params.planId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getPlan");
  }
};

/** POST /api/pdp/resolve-devices — reachable+discoverable devices of a target user. Body: { requesterDevice?, targetUser }. */
export const resolveDevices = async (req, res) => {
  try {
    const result = await pdpApi.resolveDevices({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resolveDevices");
  }
};

/** POST /api/pdp/resolve-preferred — the single preferred device + transport. Body: { requesterDevice, targetUser, selectionPolicy? }. */
export const resolvePreferred = async (req, res) => {
  try {
    const preferred = await pdpApi.resolvePreferredDevice({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, preferred });
  } catch (error) {
    return handleError(res, error, "resolvePreferred");
  }
};

/** POST /api/pdp/:discoveryId/recover — retry a recoverable failed discovery. */
export const recover = async (req, res) => {
  try {
    const outcome = await pdpApi.recover({ actingUser: callerId(req), discoveryId: req.params.discoveryId });
    return res.status(200).json({ success: true, ...outcome });
  } catch (error) {
    return handleError(res, error, "recover");
  }
};

/** POST /api/pdp/:discoveryId/cancel — cancel an active discovery. Body: { reason? }. */
export const cancel = async (req, res) => {
  try {
    const session = await pdpApi.cancel({ actingUser: callerId(req), discoveryId: req.params.discoveryId, reason: req.body?.reason });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "cancel");
  }
};

/** GET /api/pdp — the caller's discovery history (`?active=true&limit=N`). */
export const history = async (req, res) => {
  try {
    const discoveries = await pdpApi.history({ actingUser: callerId(req), activeOnly: req.query.active === "true", limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, discoveries });
  } catch (error) {
    return handleError(res, error, "history");
  }
};

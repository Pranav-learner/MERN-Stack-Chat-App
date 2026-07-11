/**
 * @module controllers/presenceController
 *
 * HTTP handlers for the **Presence Service** (Layer 6, Sprint 2), mounted at `/api/presence`.
 * This is the Express BINDING of the transport-independent
 * {@link module:presence/api Presence API facade}; the WebSocket layer (see
 * {@link presenceSocket}) is a second binding over the SAME manager, so presence stays
 * consistent across transports.
 *
 * Presence answers *which authenticated devices are currently reachable* — never *how* to reach
 * them (no capability exchange, NAT traversal, or transport negotiation in this sprint). Every
 * route sits behind the EXISTING `protectedRoute` JWT middleware; the authenticated
 * `req.user._id` is the presence owner (`actingUser`), which the facade uses to scope
 * registration/updates/heartbeats to their owner.
 *
 * @security These endpoints only ever return PUBLIC presence metadata — public identity keys +
 * fingerprints, ids, statuses, timestamps. They never accept or return a private key, session
 * key, message key, chain key, or shared secret.
 */

import { PresenceManager } from "../presence/manager/presenceManager.js";
import { createPresenceApi } from "../presence/api/presenceApi.js";
import { createPresenceService } from "../presence/services/presenceService.js";
import { HeartbeatMonitor } from "../presence/heartbeat/heartbeat.js";
import { createMongoPresenceRepository } from "../presence/repository/mongoPresenceRepository.js";
import { PresenceEventBus } from "../presence/events/events.js";
import { PresenceError } from "../presence/errors.js";

/**
 * Shared presence event bus. Future Layer 6 sprints (Capability Exchange, NAT Traversal) and the
 * socket layer subscribe here to react to presence changes without polling.
 */
export const presenceEvents = new PresenceEventBus();

/** Process-wide Presence Manager: Mongo-backed records + shared event bus. */
export const presenceManager = new PresenceManager({
  ...createMongoPresenceRepository(),
  events: presenceEvents,
});

/** The stable, transport-independent facade the HTTP handlers delegate to. */
export const presenceApi = createPresenceApi(presenceManager);

/** Socket-oriented service (connect / heartbeat / disconnect) reused by the WebSocket layer. */
export const presenceService = createPresenceService({ manager: presenceManager });

/**
 * Background heartbeat monitor — periodically sweeps heartbeat-expired devices to EXPIRED. It is
 * started from server.js (after the DB connects). The timer is `unref`'d so it never keeps the
 * process alive on its own.
 */
export const heartbeatMonitor = new HeartbeatMonitor({ manager: presenceManager });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof PresenceError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/presence/register — register (or revive) the caller's device presence.
 * Body: { deviceId, identityId?, identity?, status?, softwareVersion?, platform?, timeoutMs?, metadata? }.
 */
export const register = async (req, res) => {
  try {
    const presence = await presenceApi.register({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, presence });
  } catch (error) {
    return handleError(res, error, "register");
  }
};

/** PATCH /api/presence/:presenceId — update the caller's device status. Body: { status, metadata?, softwareVersion?, platform? }. */
export const update = async (req, res) => {
  try {
    const presence = await presenceApi.update({ actingUser: callerId(req), presenceId: req.params.presenceId, ...(req.body ?? {}) });
    return res.status(200).json({ success: true, presence });
  } catch (error) {
    return handleError(res, error, "update");
  }
};

/** POST /api/presence/:presenceId/heartbeat — refresh the caller's device liveness. Body: { timeoutMs? }. */
export const heartbeat = async (req, res) => {
  try {
    const presence = await presenceApi.heartbeat({ actingUser: callerId(req), presenceId: req.params.presenceId, timeoutMs: req.body?.timeoutMs });
    return res.status(200).json({ success: true, presence });
  } catch (error) {
    return handleError(res, error, "heartbeat");
  }
};

/** POST /api/presence/:presenceId/offline — mark the caller's device cleanly offline. */
export const goOffline = async (req, res) => {
  try {
    const presence = await presenceApi.goOffline({ actingUser: callerId(req), presenceId: req.params.presenceId, reason: req.body?.reason });
    return res.status(200).json({ success: true, presence });
  } catch (error) {
    return handleError(res, error, "goOffline");
  }
};

/** DELETE /api/presence/:presenceId — remove the caller's device presence record. */
export const remove = async (req, res) => {
  try {
    const result = await presenceApi.remove({ actingUser: callerId(req), presenceId: req.params.presenceId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "remove");
  }
};

/** GET /api/presence/lookup/:userId — resolve which of a user's devices are reachable. */
export const lookup = async (req, res) => {
  try {
    const result = await presenceApi.lookup({ actingUser: callerId(req), userId: req.params.userId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "lookup");
  }
};

/** GET /api/presence/online/:userId — list a user's visible-online devices. */
export const listOnline = async (req, res) => {
  try {
    const online = await presenceApi.listOnline({ actingUser: callerId(req), userId: req.params.userId });
    return res.status(200).json({ success: true, online });
  } catch (error) {
    return handleError(res, error, "listOnline");
  }
};

/** GET /api/presence/last-seen/:userId/:deviceId — a device's last-seen view. */
export const lastSeen = async (req, res) => {
  try {
    const result = await presenceApi.lastSeen({ actingUser: callerId(req), userId: req.params.userId, deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, lastSeen: result });
  } catch (error) {
    return handleError(res, error, "lastSeen");
  }
};

/** GET /api/presence/:presenceId — full presence view (`?history=true`). */
export const getPresence = async (req, res) => {
  try {
    const presence = await presenceApi.getPresence({ actingUser: callerId(req), presenceId: req.params.presenceId, includeHistory: req.query.history === "true" });
    return res.status(200).json({ success: true, presence });
  } catch (error) {
    return handleError(res, error, "getPresence");
  }
};

/** GET /api/presence/:presenceId/history — a device's status history. */
export const getHistory = async (req, res) => {
  try {
    const history = await presenceApi.history({ actingUser: callerId(req), presenceId: req.params.presenceId });
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getHistory");
  }
};

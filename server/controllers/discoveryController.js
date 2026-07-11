/**
 * @module controllers/discoveryController
 *
 * HTTP handlers for the **Peer Discovery Framework** (Layer 6, Sprint 1), mounted at
 * `/api/discovery`. This is the Express BINDING of the transport-independent
 * {@link module:peer-discovery/api Discovery API facade}; a future WebSocket / WebRTC-
 * signaling / QUIC transport reuses the same facade instead of re-implementing discovery.
 *
 * Discovery answers WHO a peer is and WHICH devices they have — never HOW to reach them
 * (no presence, capability exchange, NAT traversal, or transport negotiation in this
 * sprint). Every route sits behind the EXISTING `protectedRoute` JWT middleware; the
 * authenticated `req.user._id` is the discovery requester (`actingUser`), which the facade
 * uses to scope reads/actions to their owner.
 *
 * @security These endpoints only ever return PUBLIC control-plane metadata — public
 * identity/device keys + fingerprints, ids, states, counts. They never accept or return a
 * private key, session key, message key, chain key, or shared secret. The device-register
 * endpoint only lets a caller (de)register their OWN devices.
 */

import { DiscoveryManager } from "../peer-discovery/manager/discoveryManager.js";
import { createDiscoveryApi } from "../peer-discovery/api/discoveryApi.js";
import { createMongoDiscoveryRepository } from "../peer-discovery/repository/mongoDiscoveryRepository.js";
import { createMongoIdentityDirectory } from "../peer-discovery/registry/mongoIdentityDirectory.js";
import { DiscoveryEventBus } from "../peer-discovery/events/events.js";
import { DiscoveryError } from "../peer-discovery/errors.js";

/**
 * Shared discovery event bus. Future Layer 6 sprints (Presence, Capability Exchange, NAT
 * Traversal) subscribe here to react to lookups without polling.
 */
export const discoveryEvents = new DiscoveryEventBus();

/** Process-wide Discovery Manager: Mongo-backed sessions/registry + identity directory. */
export const discoveryManager = new DiscoveryManager({
  ...createMongoDiscoveryRepository(),
  directory: createMongoIdentityDirectory(),
  events: discoveryEvents,
});

/** The stable, transport-independent facade the HTTP handlers delegate to. */
export const discoveryApi = createDiscoveryApi(discoveryManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof DiscoveryError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/discovery/lookup/user — resolve a peer → identity + all discoverable devices.
 * Body: { targetUser, requesterDevice?, ttlMs?, metadata? }. Returns the discovery session
 * (+ resolved metadata, or a FAILED session with `failureReason` for an unknown peer).
 */
export const lookupUser = async (req, res) => {
  try {
    const { targetUser, requesterDevice, ttlMs, metadata } = req.body ?? {};
    const result = await discoveryApi.lookupUser({ actingUser: callerId(req), targetUser, requesterDevice, ttlMs, metadata });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "lookupUser");
  }
};

/**
 * POST /api/discovery/lookup/device — resolve a single device of a peer.
 * Body: { targetUser, deviceId, requesterDevice?, ttlMs? }.
 */
export const lookupDevice = async (req, res) => {
  try {
    const { targetUser, deviceId, requesterDevice, ttlMs } = req.body ?? {};
    const result = await discoveryApi.lookupDevice({ actingUser: callerId(req), targetUser, deviceId, requesterDevice, ttlMs });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "lookupDevice");
  }
};

/**
 * POST /api/discovery/lookup/devices — resolve a subset (or all) of a peer's devices.
 * Body: { targetUser, deviceIds?, requesterDevice?, ttlMs? }.
 */
export const lookupDevices = async (req, res) => {
  try {
    const { targetUser, deviceIds, requesterDevice, ttlMs } = req.body ?? {};
    const result = await discoveryApi.lookupDevices({ actingUser: callerId(req), targetUser, deviceIds, requesterDevice, ttlMs });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "lookupDevices");
  }
};

/**
 * POST /api/discovery/sessions — stage a discovery session (CREATED → PENDING) without
 * resolving it. Body: { targetUser, targetDevices?, requesterDevice?, ttlMs? }.
 */
export const createSession = async (req, res) => {
  try {
    const { targetUser, targetDevices, requesterDevice, ttlMs, metadata } = req.body ?? {};
    const { session } = await discoveryApi.createSession({ actingUser: callerId(req), targetUser, targetDevices, requesterDevice, ttlMs, metadata });
    return res.status(201).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "createSession");
  }
};

/** GET /api/discovery?active=true — list the caller's discoveries. */
export const list = async (req, res) => {
  try {
    const activeOnly = req.query.active === "true" || req.query.active === "1";
    const discoveries = activeOnly
      ? await discoveryApi.listActive({ actingUser: callerId(req) })
      : await discoveryApi.list({ actingUser: callerId(req) });
    return res.status(200).json({ success: true, discoveries });
  } catch (error) {
    return handleError(res, error, "list");
  }
};

/** GET /api/discovery/:discoveryId — full session view (requester-scoped). */
export const getDiscovery = async (req, res) => {
  try {
    const session = await discoveryApi.getDiscovery({
      actingUser: callerId(req),
      discoveryId: req.params.discoveryId,
      includeAudit: req.query.audit === "true",
    });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "getDiscovery");
  }
};

/** GET /api/discovery/:discoveryId/status — compact status (for polling). */
export const getStatus = async (req, res) => {
  try {
    const status = await discoveryApi.getStatus({ actingUser: callerId(req), discoveryId: req.params.discoveryId });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** POST /api/discovery/:discoveryId/cancel — cancel an active discovery. Body: { reason? }. */
export const cancel = async (req, res) => {
  try {
    const session = await discoveryApi.cancel({ actingUser: callerId(req), discoveryId: req.params.discoveryId, reason: req.body?.reason });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "cancel");
  }
};

/** POST /api/discovery/:discoveryId/complete — mark a resolved discovery consumed. */
export const complete = async (req, res) => {
  try {
    const session = await discoveryApi.complete({ actingUser: callerId(req), discoveryId: req.params.discoveryId });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "complete");
  }
};

/**
 * POST /api/discovery/register — register one of the CALLER'S OWN devices as discoverable.
 * Body: { deviceId, publicKey, fingerprint, identityId?, algorithm?, name?, platform? }.
 * `userId` is forced to the authenticated caller so nobody can register on another's behalf.
 */
export const registerDevice = async (req, res) => {
  try {
    const body = req.body ?? {};
    const descriptor = await discoveryManager.registerDevice({ ...body, userId: callerId(req) });
    return res.status(200).json({ success: true, device: descriptor });
  } catch (error) {
    return handleError(res, error, "registerDevice");
  }
};

/** POST /api/discovery/deregister — deregister one of the caller's own devices. Body: { deviceId }. */
export const deregisterDevice = async (req, res) => {
  try {
    const removed = await discoveryManager.deregisterDevice(callerId(req), req.body?.deviceId);
    return res.status(200).json({ success: true, removed });
  } catch (error) {
    return handleError(res, error, "deregisterDevice");
  }
};

/**
 * @module controllers/capabilityController
 *
 * HTTP handlers for the **Capability Exchange** subsystem (Layer 6, Sprint 3), mounted at
 * `/api/capabilities`. This is the Express BINDING of the transport-independent
 * {@link module:capabilities/api Capability API facade}; a future WebRTC-signaling / QUIC transport
 * reuses the same facade instead of re-implementing capability exchange.
 *
 * Capability Exchange answers *how two devices can communicate* — it determines COMPATIBILITY and a
 * PREFERRED communication strategy. It does NOT establish connections, perform NAT traversal, or do
 * any ICE/STUN/TURN/WebRTC work (later layers). Every route sits behind the EXISTING
 * `protectedRoute` JWT middleware; the authenticated `req.user._id` owns the capabilities it
 * registers/updates and is the requester in a negotiation.
 *
 * @security These endpoints only ever return PUBLIC capability metadata — versions, transport
 * names, feature flags, limits. They never accept or return a private key, session key, message
 * key, chain key, or shared secret.
 */

import { CapabilityManager } from "../capabilities/manager/capabilityManager.js";
import { createCapabilityApi } from "../capabilities/api/capabilityApi.js";
import { createMongoCapabilityRepository } from "../capabilities/repository/mongoCapabilityRepository.js";
import { CapabilityEventBus } from "../capabilities/events/events.js";
import { CapabilityError } from "../capabilities/errors.js";

/**
 * Shared capability event bus. Future Layer 6/7 sprints (NAT Traversal) subscribe here to react to
 * negotiations without polling.
 */
export const capabilityEvents = new CapabilityEventBus();

/** Process-wide Capability Manager: Mongo-backed capabilities + negotiation history. */
export const capabilityManager = new CapabilityManager({
  ...createMongoCapabilityRepository(),
  events: capabilityEvents,
});

/** The stable, transport-independent facade the HTTP handlers delegate to. */
export const capabilityApi = createCapabilityApi(capabilityManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof CapabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/capabilities/register — register the caller's device capabilities.
 * Body: { deviceId, identityId?, protocolVersions?, cryptoVersions?, transports?, compression?,
 *         attachments?, maxPayloadSize?, relaySupport?, connectionPreferences?, platformFeatures?,
 *         softwareVersion?, featureFlags?, ttlMs?, metadata? }.
 */
export const register = async (req, res) => {
  try {
    const capabilities = await capabilityApi.register({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, capabilities });
  } catch (error) {
    return handleError(res, error, "register");
  }
};

/** PATCH /api/capabilities/:capabilityId — update the caller's capabilities (bumps the version). */
export const update = async (req, res) => {
  try {
    const capabilities = await capabilityApi.update({ actingUser: callerId(req), capabilityId: req.params.capabilityId, ...(req.body ?? {}) });
    return res.status(200).json({ success: true, capabilities });
  } catch (error) {
    return handleError(res, error, "update");
  }
};

/** POST /api/capabilities/:capabilityId/refresh — extend the caller's capability TTL. */
export const refresh = async (req, res) => {
  try {
    const capabilities = await capabilityApi.refresh({ actingUser: callerId(req), capabilityId: req.params.capabilityId, ttlMs: req.body?.ttlMs });
    return res.status(200).json({ success: true, capabilities });
  } catch (error) {
    return handleError(res, error, "refresh");
  }
};

/** DELETE /api/capabilities/:capabilityId — remove the caller's capability set. */
export const remove = async (req, res) => {
  try {
    const result = await capabilityApi.remove({ actingUser: callerId(req), capabilityId: req.params.capabilityId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "remove");
  }
};

/**
 * POST /api/capabilities/negotiate — negotiate how the caller's device + a peer's device can
 * communicate. Body: { requesterDevice, targetUser, targetDevice, policy? }.
 */
export const negotiate = async (req, res) => {
  try {
    const outcome = await capabilityApi.negotiate({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, ...outcome });
  } catch (error) {
    return handleError(res, error, "negotiate");
  }
};

/**
 * POST /api/capabilities/preferred-transport — resolve just the preferred transport (+ fallback)
 * for the caller's device + a peer's. Body: { requesterDevice, targetUser, targetDevice, policy? }.
 */
export const preferredTransport = async (req, res) => {
  try {
    const transport = await capabilityApi.resolvePreferredTransport({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, transport });
  } catch (error) {
    return handleError(res, error, "preferredTransport");
  }
};

/** GET /api/capabilities/device/:userId/:deviceId — a device's advertised capabilities. */
export const getDeviceCapabilities = async (req, res) => {
  try {
    const capabilities = await capabilityApi.getDeviceCapabilities({ actingUser: callerId(req), userId: req.params.userId, deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, capabilities });
  } catch (error) {
    return handleError(res, error, "getDeviceCapabilities");
  }
};

/** GET /api/capabilities/history/:deviceId — the caller device's negotiation history. */
export const getHistory = async (req, res) => {
  try {
    const history = await capabilityApi.history({ actingUser: callerId(req), deviceId: req.params.deviceId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getHistory");
  }
};

/** GET /api/capabilities/:capabilityId — a capability set's full view (`?history=true`). */
export const getCapabilities = async (req, res) => {
  try {
    const capabilities = await capabilityApi.getCapabilities({ actingUser: callerId(req), capabilityId: req.params.capabilityId, includeHistory: req.query.history === "true" });
    return res.status(200).json({ success: true, capabilities });
  } catch (error) {
    return handleError(res, error, "getCapabilities");
  }
};

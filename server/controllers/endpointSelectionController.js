/**
 * @module controllers/endpointSelectionController
 *
 * HTTP handlers for the **Endpoint Selection & Connection Planning** subsystem (Layer 6, Sprint 5),
 * mounted at `/api/endpoint-selection`. This is the Express BINDING of the transport-independent
 * {@link module:endpoint-selection/api Endpoint API facade}. It takes candidate devices (typically
 * the reachable, capability-compatible devices a PDP run resolved — supplied by the client) and
 * produces an OPTIMIZED, failover-ready connection plan.
 *
 * This subsystem selects endpoints + prepares plans with failover. It establishes NOTHING — no NAT
 * traversal, ICE, WebRTC, or sockets (that is Layer 7). Every route sits behind the EXISTING
 * `protectedRoute` JWT middleware; the authenticated `req.user._id` is the requester.
 *
 * @security These endpoints only ever return PUBLIC control-plane metadata — device ids, public
 * identities, presence status, negotiated versions/transports/flags, scores. They never accept or
 * return a private key, session key, message key, chain key, or shared secret.
 */

import { EndpointSelectionManager } from "../endpoint-selection/manager/endpointSelectionManager.js";
import { createEndpointApi } from "../endpoint-selection/api/endpointApi.js";
import { createMongoEndpointRepository } from "../endpoint-selection/repository/mongoEndpointRepository.js";
import { EndpointEventBus } from "../endpoint-selection/events/events.js";
import { EndpointError } from "../endpoint-selection/errors.js";

/**
 * Shared endpoint-selection event bus. Future Layer 7 (NAT Traversal) subscribes here to consume
 * connection plans + routing updates as they are produced.
 */
export const endpointEvents = new EndpointEventBus();

/** Process-wide Endpoint Selection Manager: Mongo-backed plans + selection history + reliability. */
export const endpointSelectionManager = new EndpointSelectionManager({
  ...createMongoEndpointRepository(),
  events: endpointEvents,
});

/** The stable, transport-independent facade the HTTP handlers delegate to. */
export const endpointApi = createEndpointApi(endpointSelectionManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof EndpointError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/endpoint-selection/plan — generate an optimized connection plan.
 * Body: { requesterDevice, targetUser, candidates[], policy?, preferredPlatform?, preferredDeviceId?,
 *         securityRequirements?, maxFallbacks?, retry?, useCache? }.
 */
export const generatePlan = async (req, res) => {
  try {
    const outcome = await endpointApi.generatePlan({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, ...outcome });
  } catch (error) {
    return handleError(res, error, "generatePlan");
  }
};

/** POST /api/endpoint-selection/select — select just the primary endpoint. */
export const selectEndpoint = async (req, res) => {
  try {
    const endpoint = await endpointApi.selectEndpoint({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, endpoint });
  } catch (error) {
    return handleError(res, error, "selectEndpoint");
  }
};

/** POST /api/endpoint-selection/rank — rank candidate devices (no plan). */
export const rankDevices = async (req, res) => {
  try {
    const result = await endpointApi.rankDevices({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "rankDevices");
  }
};

/** GET /api/endpoint-selection/:planId — a connection plan by id. */
export const getPlan = async (req, res) => {
  try {
    const result = await endpointApi.getPlan({ actingUser: callerId(req), planId: req.params.planId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getPlan");
  }
};

/** GET /api/endpoint-selection/:planId/status — compact endpoint status. */
export const getStatus = async (req, res) => {
  try {
    const status = await endpointApi.getStatus({ actingUser: callerId(req), planId: req.params.planId });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/endpoint-selection/:planId/fallbacks — the plan's fallback endpoints. */
export const getFallbacks = async (req, res) => {
  try {
    const fallbacks = await endpointApi.getFallbacks({ actingUser: callerId(req), planId: req.params.planId });
    return res.status(200).json({ success: true, fallbacks });
  } catch (error) {
    return handleError(res, error, "getFallbacks");
  }
};

/** POST /api/endpoint-selection/:planId/failover — promote the next fallback. Body: { reason? }. */
export const failover = async (req, res) => {
  try {
    const plan = await endpointApi.failover({ actingUser: callerId(req), planId: req.params.planId, reason: req.body?.reason });
    return res.status(200).json({ success: true, plan });
  } catch (error) {
    return handleError(res, error, "failover");
  }
};

/** POST /api/endpoint-selection/:planId/refresh — rebuild routing from fresh candidates. Body: { candidates[] }. */
export const refreshPlan = async (req, res) => {
  try {
    const plan = await endpointApi.refreshPlan({ actingUser: callerId(req), planId: req.params.planId, candidates: req.body?.candidates });
    return res.status(200).json({ success: true, plan });
  } catch (error) {
    return handleError(res, error, "refreshPlan");
  }
};

/** POST /api/endpoint-selection/:planId/reroute — try a specific device first. Body: { deviceId }. */
export const updateRouting = async (req, res) => {
  try {
    const plan = await endpointApi.updateRouting({ actingUser: callerId(req), planId: req.params.planId, deviceId: req.body?.deviceId });
    return res.status(200).json({ success: true, plan });
  } catch (error) {
    return handleError(res, error, "updateRouting");
  }
};

/** POST /api/endpoint-selection/:planId/outcome — record an endpoint outcome. Body: { deviceId, outcome }. */
export const recordOutcome = async (req, res) => {
  try {
    const reliability = await endpointApi.recordOutcome({ actingUser: callerId(req), planId: req.params.planId, deviceId: req.body?.deviceId, outcome: req.body?.outcome });
    return res.status(200).json({ success: true, reliability });
  } catch (error) {
    return handleError(res, error, "recordOutcome");
  }
};

/** GET /api/endpoint-selection — selection/routing history (`?target=...&limit=N`). */
export const history = async (req, res) => {
  try {
    const selections = await endpointApi.history({ actingUser: callerId(req), targetUser: req.query.target, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, selections });
  } catch (error) {
    return handleError(res, error, "history");
  }
};

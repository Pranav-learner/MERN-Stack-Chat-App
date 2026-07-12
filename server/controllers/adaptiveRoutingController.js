/**
 * @module controllers/adaptiveRoutingController
 *
 * HTTP handlers for the **Intelligent Routing** subsystem (Layer 12, Sprint 2), mounted at
 * `/api/adaptive-routing`. It turns a communication request into an intelligent, explainable routing
 * decision: collect capabilities, analyze the communication + network, score candidate routes, select the
 * optimal strategy, and produce fallback + execution plans. It is INDEPENDENT of the Sprint-1 Fabric
 * controller (which it also enhances — see below) and carries NO content/keys.
 *
 * Every route is JWT-protected; the caller may only decide as themselves (`senderId = caller`).
 *
 * @security Reasons over control-plane metadata + declared capability + availability only.
 */

import { AdaptiveRoutingEngine } from "../adaptive-routing/manager/adaptiveRoutingEngine.js";
import { createAdaptiveRoutingApi } from "../adaptive-routing/api/adaptiveRoutingApi.js";
import { createMongoAdaptiveRepository } from "../adaptive-routing/repository/mongoAdaptiveRepository.js";
import { AdaptiveEventBus } from "../adaptive-routing/events/events.js";
import { AdaptiveRoutingError } from "../adaptive-routing/errors.js";

/** Shared adaptive event bus. Sprint 3 (resource optimization / QoS) subscribes here. */
export const adaptiveEvents = new AdaptiveEventBus();

/** Process-wide Adaptive Routing Engine over the Mongo-backed repository. */
export const adaptiveRoutingEngine = new AdaptiveRoutingEngine({ ...createMongoAdaptiveRepository(), events: adaptiveEvents });

/** The stable facade the HTTP handlers delegate to. */
export const adaptiveRoutingApi = createAdaptiveRoutingApi(adaptiveRoutingEngine);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof AdaptiveRoutingError || error?.code?.startsWith?.("ERR_FABRIC")) {
    return res.status(error.status ?? 400).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /evaluate — full intelligent evaluation (the primary entry point). Body: a communication request + adaptive hints. */
export const evaluateCommunication = async (req, res) => {
  try {
    const result = await adaptiveRoutingApi.evaluate({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return handleError(res, error, "evaluateCommunication");
  }
};

/** POST /best-route — the best route only (dry run). */
export const getBestRoute = async (req, res) => {
  try {
    const bestRoute = await adaptiveRoutingApi.getBestRoute({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, bestRoute });
  } catch (error) {
    return handleError(res, error, "getBestRoute");
  }
};

/** POST /capability-profile — the negotiated capability profile for a communication. */
export const getCapabilityProfile = async (req, res) => {
  try {
    const profile = await adaptiveRoutingApi.getCapabilityProfile({ senderId: callerId(req), recipients: req.body?.recipients ?? [], senderCapabilities: req.body?.capabilities, receiverCapabilities: req.body?.receiverCapabilities });
    return res.status(200).json({ success: true, profile });
  } catch (error) {
    return handleError(res, error, "getCapabilityProfile");
  }
};

/** POST /route-scores — the ranked route scores (dry run). */
export const getRouteScores = async (req, res) => {
  try {
    const scores = await adaptiveRoutingApi.getRouteScores({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, scores });
  } catch (error) {
    return handleError(res, error, "getRouteScores");
  }
};

/** POST /explain — the decision explanation (dry run). */
export const getDecisionExplanation = async (req, res) => {
  try {
    const explanation = await adaptiveRoutingApi.getDecisionExplanation({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, explanation });
  } catch (error) {
    return handleError(res, error, "getDecisionExplanation");
  }
};

/** POST /fallback-plan — the deterministic fallback plan (dry run). */
export const getFallbackPlan = async (req, res) => {
  try {
    const fallbackPlan = await adaptiveRoutingApi.getFallbackPlan({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, fallbackPlan });
  } catch (error) {
    return handleError(res, error, "getFallbackPlan");
  }
};

/** GET /diagnostics/:requestId — evaluation diagnostics + audit trail. */
export const diagnostics = async (req, res) => {
  try {
    const diag = await adaptiveRoutingApi.diagnostics({ requestId: req.params.requestId });
    return res.status(200).json({ success: true, diagnostics: diag });
  } catch (error) {
    return handleError(res, error, "diagnostics");
  }
};

/** GET /health — adaptive control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await adaptiveRoutingApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

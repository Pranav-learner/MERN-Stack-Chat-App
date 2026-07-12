/**
 * @module controllers/optimizationController
 *
 * HTTP handlers for the **Resource Optimization** subsystem (Layer 12, Sprint 3), mounted at
 * `/api/optimization`. It optimizes a communication globally — QoS classification, scheduling, resource
 * allocation, cross-device coordination, workload balancing, and an optimized execution plan — WITHOUT
 * modifying any lower communication layer. It also EXPORTS the `executionHook` the Communication Fabric
 * controller wires in, so the whole platform is globally optimized.
 *
 * Every route is JWT-protected; the caller may only optimize as themselves (`senderId = caller`).
 *
 * @security Reasons over control-plane metadata + abstract resource UNITS only — never content/keys.
 */

import { GlobalOptimizer } from "../optimization/manager/globalOptimizer.js";
import { createOptimizationApi } from "../optimization/api/optimizationApi.js";
import { createMongoOptimizationRepository } from "../optimization/repository/mongoOptimizationRepository.js";
import { createFabricOptimizationIntegration } from "../optimization/integration/fabricIntegration.js";
import { OptimizationEventBus } from "../optimization/events/events.js";
import { OptimizationError } from "../optimization/errors.js";

/** Shared optimization event bus. Sprint 4 (production hardening / monitoring) subscribes here. */
export const optimizationEvents = new OptimizationEventBus();

/** Process-wide Global Optimizer over the Mongo-backed repository. */
export const globalOptimizer = new GlobalOptimizer({ ...createMongoOptimizationRepository(), events: optimizationEvents });

/** The stable facade the HTTP handlers delegate to. */
export const optimizationApi = createOptimizationApi(globalOptimizer);

/** The Fabric execution hook — the Communication Fabric controller spreads this into its manager. */
export const { executionHook: optimizationExecutionHook } = createFabricOptimizationIntegration({ optimizer: globalOptimizer });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof OptimizationError || error?.code?.startsWith?.("ERR_FABRIC")) {
    return res.status(error.status ?? 400).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /schedule — full global optimization of a communication (the primary entry point). */
export const scheduleCommunication = async (req, res) => {
  try {
    const result = await optimizationApi.schedule({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return handleError(res, error, "scheduleCommunication");
  }
};

/** POST /execution-plan — the optimized execution plan (dry run). */
export const getExecutionPlan = async (req, res) => {
  try {
    const plan = await optimizationApi.getExecutionPlan({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, plan });
  } catch (error) {
    return handleError(res, error, "getExecutionPlan");
  }
};

/** POST /qos — the QoS profile (dry run). */
export const getQoSProfile = async (req, res) => {
  try {
    const qos = await optimizationApi.getQoSProfile({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, qos });
  } catch (error) {
    return handleError(res, error, "getQoSProfile");
  }
};

/** POST /resource-allocation — the resource allocation recommendation (dry run). */
export const getResourceAllocation = async (req, res) => {
  try {
    const allocation = await optimizationApi.getResourceAllocation({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, allocation });
  } catch (error) {
    return handleError(res, error, "getResourceAllocation");
  }
};

/** GET /scheduler-state — the current scheduler + workload-balancer state. */
export const getSchedulerState = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, state: optimizationApi.getSchedulerState() });
  } catch (error) {
    return handleError(res, error, "getSchedulerState");
  }
};

/** POST /dispatch — drain ready queued work (adaptive dispatch). */
export const dispatch = async (req, res) => {
  try {
    return res.status(200).json({ success: true, dispatch: optimizationApi.dispatch({ maxConcurrent: req.body?.maxConcurrent }) });
  } catch (error) {
    return handleError(res, error, "dispatch");
  }
};

/** GET /diagnostics/:requestId — optimization diagnostics + audit trail. */
export const diagnostics = async (req, res) => {
  try {
    const diag = await optimizationApi.diagnostics({ requestId: req.params.requestId });
    return res.status(200).json({ success: true, diagnostics: diag });
  } catch (error) {
    return handleError(res, error, "diagnostics");
  }
};

/** GET /status — Fabric optimization status / health. */
export const status = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, status: await optimizationApi.status() });
  } catch (error) {
    return handleError(res, error, "status");
  }
};

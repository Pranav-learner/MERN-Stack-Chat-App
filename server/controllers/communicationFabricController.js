/**
 * @module controllers/communicationFabricController
 *
 * HTTP handlers for the **Distributed Communication Fabric** (Layer 12, Sprint 1), mounted at
 * `/api/communication-fabric`. The Fabric is the single orchestration entry point: an application sends a
 * communication REQUEST here, and the Fabric builds a context, evaluates policies, decides a strategy +
 * route, plans the execution, and delegates each step to a registered lower-layer subsystem — WITHOUT
 * reimplementing any of them.
 *
 * ## Subsystem wiring (STEP 12 — Client Integration)
 * The controller registers one adapter per frozen lower layer (messaging, media, synchronization, group,
 * delivery, presence, connectivity). In Sprint 1 an adapter is a control-plane HANDOFF: it acknowledges
 * that the Fabric selected that subsystem for the step and returns a delegation descriptor. The actual
 * encrypted work still runs through each subsystem's own frozen API (which the client already calls) —
 * the Fabric decides HOW communication occurs and in WHAT order; it never moves bytes or keys. Sprint 2
 * (intelligent routing) replaces these handoffs with adaptive, measured delegation.
 *
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware; the caller may only initiate
 * communication as themselves (the manager authorizes `senderId === caller`).
 *
 * @security The Fabric reasons over control-plane metadata only. A no-content scan guards every persist.
 */

import { CommunicationFabricManager } from "../communication-fabric/manager/communicationFabricManager.js";
import { createFabricApi } from "../communication-fabric/api/fabricApi.js";
import { createMongoFabricRepository } from "../communication-fabric/repository/mongoFabricRepository.js";
import { createSubsystemAdapter } from "../communication-fabric/registry/subsystemAdapter.js";
import { FabricEventBus } from "../communication-fabric/events/events.js";
import { FabricError, SubsystemKind, createDefaultStrategyRegistry } from "../communication-fabric/index.js";
import { createFabricAdaptiveIntegration } from "../adaptive-routing/integration/fabricIntegration.js";

/** Shared fabric event bus. Sprint 2 (intelligent routing) + future dashboards subscribe here. */
export const fabricEvents = new FabricEventBus();

// Layer 12 Sprint 2 — make the Fabric INTELLIGENT: a shared strategy registry + the adaptive integration
// (scoring-driven decision rule + adaptive route planner) turn the Fabric's deterministic decision into an
// adaptive one. The decision is now ordered by capability/network/policy route scores, and every plan
// carries scored, ranked fallback routes + `adaptive: true` diagnostics. Backward compatible: the manager
// still authorizes, validates, orchestrates, and persists exactly as in Sprint 1.
const fabricStrategyRegistry = createDefaultStrategyRegistry();
const adaptiveIntegration = createFabricAdaptiveIntegration({ strategyRegistry: fabricStrategyRegistry, fabricEvents });

/** Process-wide Communication Fabric Manager over the Mongo-backed repository, now adaptive. */
export const communicationFabricManager = new CommunicationFabricManager({
  ...createMongoFabricRepository(),
  events: fabricEvents,
  strategyRegistry: fabricStrategyRegistry,
  decisionRules: adaptiveIntegration.decisionRules,
  routePlanner: adaptiveIntegration.routePlanner,
});

/** The stable facade the HTTP handlers delegate to. */
export const fabricApi = createFabricApi(communicationFabricManager);

/**
 * Register the frozen lower layers as subsystem adapters. Each handler is a Sprint-1 control-plane
 * handoff (records the delegation + returns a descriptor); the subsystem's own API performs the encrypted
 * work. A deployment swaps any handler for a real delegating call without touching the Fabric.
 */
function handoff(kind) {
  return (step, _context) => ({ delegatedTo: kind, action: step.action, route: step.route, ready: true, note: `Fabric selected ${kind} for "${step.action}"` });
}

for (const kind of [SubsystemKind.MESSAGING, SubsystemKind.TRANSPORT, SubsystemKind.MEDIA, SubsystemKind.SYNCHRONIZATION, SubsystemKind.GROUP, SubsystemKind.DELIVERY, SubsystemKind.CONNECTIVITY, SubsystemKind.PRESENCE, SubsystemKind.SECURITY]) {
  communicationFabricManager.registerSubsystem(createSubsystemAdapter({ kind, name: `layer-adapter:${kind}`, handler: handoff(kind), metadata: { sprint: 1, mode: "handoff" } }));
}

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof FabricError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

// === the single entry point =================================================

/** POST /execute — execute a communication end-to-end through the Fabric. Body: a CommunicationRequest (no `senderId` — taken from the caller). */
export const executeCommunication = async (req, res) => {
  try {
    const result = await fabricApi.execute({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return handleError(res, error, "executeCommunication");
  }
};

/** POST /plan — plan-only (dry run): decision + execution plan, NO orchestration. */
export const planCommunication = async (req, res) => {
  try {
    const result = await fabricApi.plan({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return handleError(res, error, "planCommunication");
  }
};

// === inspection endpoints ===================================================

/** POST /context — build the immutable communication context for a request. */
export const buildContext = async (req, res) => {
  try {
    const context = await fabricApi.buildContext({ ...(req.body ?? {}), senderId: callerId(req) });
    return res.status(200).json({ success: true, context });
  } catch (error) {
    return handleError(res, error, "buildContext");
  }
};

/** POST /policies — evaluate policies for a request (bias + constraints + refs + denial). */
export const evaluatePolicies = async (req, res) => {
  try {
    const policies = await fabricApi.evaluatePolicies({ ...(req.body ?? {}), senderId: callerId(req) });
    return res.status(200).json({ success: true, policies });
  } catch (error) {
    return handleError(res, error, "evaluatePolicies");
  }
};

/** POST /strategy — get the decision (strategy + route + reasons) without executing. */
export const getStrategy = async (req, res) => {
  try {
    const decision = await fabricApi.getStrategy({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, decision });
  } catch (error) {
    return handleError(res, error, "getStrategy");
  }
};

/** POST /execution-plan — get the full execution plan without executing. */
export const getExecutionPlan = async (req, res) => {
  try {
    const plan = await fabricApi.getExecutionPlan({ ...(req.body ?? {}), senderId: callerId(req) }, { callerId: callerId(req) });
    return res.status(200).json({ success: true, plan });
  } catch (error) {
    return handleError(res, error, "getExecutionPlan");
  }
};

/** GET /diagnostics/:requestId — decision diagnostics + audit trail for a request. */
export const decisionDiagnostics = async (req, res) => {
  try {
    const diagnostics = await fabricApi.decisionDiagnostics({ requestId: req.params.requestId });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "decisionDiagnostics");
  }
};

/** GET /health — aggregate Fabric control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await fabricApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/**
 * @module controllers/automaticRekeyController
 *
 * HTTP handlers for the **Automatic Rekeying & Evolution Policy** engine (Layer 5,
 * Sprint 3). The server stores and exposes per-session rekey POLICY configuration + rekey
 * history METADATA. The actual key evolution runs on-device (Sprint 2 forward secrecy is
 * device-local), so the server-side manager is wired to the **descriptor-mode**
 * forward-secrecy manager: it tracks that rekeys happened, it never holds keys.
 *
 * Endpoints: configure policies, read status/policies/history/executions/audit, and a
 * manual-trigger endpoint that records a device-reported rekey via the FS descriptor.
 * All routes sit behind `protectedRoute` (JWT) and enforce session participation.
 */

import { AutomaticRekeyManager } from "../evolution-policy/manager/automaticRekeyManager.js";
import { createMongoPolicyRepository } from "../evolution-policy/repository/mongoPolicyRepository.js";
import { RekeyEventBus } from "../evolution-policy/events/events.js";
import { RekeyError } from "../evolution-policy/errors.js";
import { createSessionAgePolicy, createTimeBasedPolicy, createMessageCountPolicy, createManualPolicy, createSecurityEventPolicy, createDeviceEventPolicy } from "../evolution-policy/policies/policyFactory.js";
import { sessionManager } from "./secureSessionController.js";
import { forwardSecrecyManager } from "./forwardSecrecyController.js";

/** Shared rekey event bus — future Layer 5 sprints subscribe here. */
export const rekeyEvents = new RekeyEventBus();

/** Server-side automatic-rekey manager (descriptor FS → tracks metadata, holds no keys). */
export const automaticRekeyManager = new AutomaticRekeyManager({
  ...createMongoPolicyRepository(),
  forwardSecrecy: forwardSecrecyManager,
  sessions: sessionManager,
  events: rekeyEvents,
});

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof RekeyError) {
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

const POLICY_BUILDERS = {
  "session-age": (p) => createSessionAgePolicy({ maxAgeMs: p.maxAgeMs }),
  "time-based": (p) => createTimeBasedPolicy({ intervalMs: p.intervalMs }),
  "message-count": (p) => createMessageCountPolicy({ maxMessages: p.maxMessages }),
  manual: () => createManualPolicy(),
  "security-event": (p) => createSecurityEventPolicy({ events: p.events }),
  "device-event": (p) => createDeviceEventPolicy({ events: p.events }),
};

/** Build validated policy descriptors from a request body (never trust raw descriptors). */
function buildPolicies(specs = []) {
  return specs.map((spec) => {
    const builder = POLICY_BUILDERS[spec?.type];
    if (!builder) throw new RekeyError(`Unsupported policy type "${spec?.type}"`, { code: "ERR_REKEY_VALIDATION", status: 400 });
    return builder(spec);
  });
}

/**
 * POST /api/auto-rekey/:sessionId/configure — configure automatic-rekey policies.
 * Body: { policies: [{ type, ...params }], enabled?, cooldownMs? }
 */
export const configure = async (req, res) => {
  try {
    const session = await authorizeSession(req, res, req.params.sessionId);
    if (!session) return;
    const policies = buildPolicies(req.body?.policies);
    const state = await automaticRekeyManager.configure({
      sessionId: req.params.sessionId,
      handshakeId: session.handshakeId,
      sessionCreatedAt: session.createdAt,
      policies,
      enabled: req.body?.enabled,
      cooldownMs: req.body?.cooldownMs,
    });
    return res.status(201).json({ success: true, rekey: state });
  } catch (error) {
    return handleError(res, error, "configure");
  }
};

/** GET /api/auto-rekey/:sessionId — full policy-state (metadata only). */
export const getState = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const rekey = await automaticRekeyManager.getState(req.params.sessionId);
    return res.status(200).json({ success: true, rekey });
  } catch (error) {
    return handleError(res, error, "getState");
  }
};

/** GET /api/auto-rekey/:sessionId/status — compact status. */
export const getStatus = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const status = await automaticRekeyManager.getStatus(req.params.sessionId);
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/auto-rekey/:sessionId/history — rekey (generation-advance) history. */
export const getRekeyHistory = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const history = await automaticRekeyManager.getRekeyHistory(req.params.sessionId);
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getRekeyHistory");
  }
};

/** GET /api/auto-rekey/:sessionId/executions — execution history. */
export const getExecutions = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const executions = await automaticRekeyManager.getExecutionHistory(req.params.sessionId);
    return res.status(200).json({ success: true, executions });
  } catch (error) {
    return handleError(res, error, "getExecutions");
  }
};

/** GET /api/auto-rekey/:sessionId/audit — audit trail. */
export const getAudit = async (req, res) => {
  try {
    if (!(await authorizeSession(req, res, req.params.sessionId))) return;
    const audit = await automaticRekeyManager.getAudit(req.params.sessionId);
    return res.status(200).json({ success: true, audit });
  } catch (error) {
    return handleError(res, error, "getAudit");
  }
};

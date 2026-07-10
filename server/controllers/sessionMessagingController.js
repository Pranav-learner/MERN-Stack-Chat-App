/**
 * @module controllers/sessionMessagingController
 *
 * Layer 4 · Sprint 5 — production wiring for the Secure Session Integration layer +
 * its status/stats HTTP endpoints. Builds the {@link ApplicationSessionManager}
 * singleton (PERMISSIVE by default so existing messaging keeps working), wires the
 * Sprint 4 {@link SessionGuard} to the Layer 3 identity/device/trust directories, and
 * exposes the {@link MessagePipeline} + session middleware for `messageController` and
 * `server.js` to consume.
 *
 * @security Session AWARENESS only — no encryption. Endpoints return PUBLIC session
 * metadata + aggregate metrics; never keys or message content.
 */

import {
  ApplicationSessionManager,
  MessagePipeline,
  createSessionMiddleware,
} from "../session-integration/index.js";
import { SessionIntegrationError } from "../session-integration/errors.js";
import { EnforcementMode } from "../session-integration/types.js";
import { SessionGuard } from "../shs/hardening/session-guard/sessionGuard.js";

import { sessionManager as secureSessionManager } from "./secureSessionController.js";
import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { DeviceManager } from "../device-trust/manager/deviceManager.js";
import { createMongoDeviceRepository } from "../device-trust/repository/mongoRepository.js";
import { TrustManager } from "../trust/manager/trustManager.js";
import { createMongoTrustRepositories } from "../trust/repository/mongoRepository.js";

// Layer 3 directories for continuous session validation (defensive — never throw out
// of a lookup; a failed lookup degrades to "unknown", never crashes messaging).
const identityManager = new IdentityManager(createMongoRepositories());
const { devices: deviceRepo } = createMongoDeviceRepository();
const deviceManager = new DeviceManager({ devices: deviceRepo });
const trustManager = new TrustManager({
  ...createMongoTrustRepositories(),
  identityLookup: (userId) => identityManager.getIdentityByUser(userId),
});

const safe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch {
    return null;
  }
};

const guard = new SessionGuard({
  identityLookup: safe((userId) => identityManager.getIdentityByUser(userId)),
  deviceLookup: safe((userId, deviceId) => deviceManager.getDevice(userId, deviceId)),
  trustLookup: safe(async (a, b) => {
    const status = await trustManager.getVerificationStatus(a, b);
    return status ? { state: status.state } : null;
  }),
});

/** The production application session manager (PERMISSIVE: non-breaking fallback). */
export const appSessions = new ApplicationSessionManager({
  sessions: secureSessionManager,
  guard,
  enforcement: process.env.SESSION_ENFORCEMENT === "strict" ? EnforcementMode.STRICT : EnforcementMode.PERMISSIVE,
});

/** The message pipeline used by messaging controllers. */
export const messagePipeline = new MessagePipeline({ appSessions });

/** Reusable session middleware for messaging routes. */
export const sessionMiddleware = createSessionMiddleware({ appSessions, peerParam: "id" });

function handleError(res, error, where) {
  if (error instanceof SessionIntegrationError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** GET /api/messaging-session/context/:peerId — the caller's session context with a peer. */
export const getSessionContext = async (req, res) => {
  try {
    const context = await appSessions.sessionContext(String(req.user._id), req.params.peerId);
    return res.status(200).json({ success: true, context });
  } catch (error) {
    return handleError(res, error, "getSessionContext");
  }
};

/** GET /api/messaging-session/status — transport readiness + enforcement for the caller. */
export const getStatus = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      status: {
        userId: String(req.user._id),
        enforcement: appSessions.enforcement,
        transportReady: true,
        encryption: "disabled", // Layer 5 enables it via the interceptor hook
      },
    });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/messaging-session/stats — aggregate integration metrics (no PII). */
export const getStats = async (_req, res) => {
  try {
    const stats = await appSessions.getStats();
    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return handleError(res, error, "getStats");
  }
};

/**
 * @module controllers/sessionController
 *
 * Layer 3 · Sprint 4 — HTTP handlers for the consolidated identity context. These
 * are the "Application Ready" endpoints the client loads after authenticating.
 * All sit behind the EXISTING `protectedRoute` JWT middleware; JWT is unchanged.
 * No private keys are exposed.
 */

import { identityContextService } from "../integration/index.js";

/** Read the caller's current device id from a header or query param. */
function readDeviceId(req) {
  return req.query?.deviceId || req.headers["device-id"] || undefined;
}

/**
 * GET /api/session/context
 * The consolidated identity context: identity + devices + current device trust +
 * verification summary + `ready`/`sessionValid` flags.
 */
export const getContext = async (req, res) => {
  try {
    const context = await identityContextService.loadContext(req.user._id, { deviceId: readDeviceId(req) });
    return res.status(200).json({ success: true, context });
  } catch (error) {
    console.log("Error in getContext", error?.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

/**
 * GET /api/session/validate
 * Whether the caller's (user, device) session is currently valid (device not
 * revoked/blocked). Clients call this to enforce "device revoked → invalidate".
 */
export const validateSession = async (req, res) => {
  try {
    const result = await identityContextService.validateSession(req.user._id, readDeviceId(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.log("Error in validateSession", error?.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

/**
 * GET /api/session/directory
 * The caller's verification state for each subject they've verified — for badging
 * contacts on the client. Fast (no per-subject queries).
 */
export const getDirectory = async (req, res) => {
  try {
    const directory = await identityContextService.verificationDirectory(req.user._id);
    return res.status(200).json({ success: true, directory });
  } catch (error) {
    console.log("Error in getDirectory", error?.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

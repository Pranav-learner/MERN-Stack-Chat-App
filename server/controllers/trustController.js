/**
 * @module controllers/trustController
 *
 * HTTP handlers for the Trust subsystem (Layer 3, Sprint 3). Thin adapters over
 * the {@link TrustManager}. They never touch private keys and never modify the
 * existing auth/chat controllers. All routes sit behind `protectedRoute` (JWT).
 *
 * The manager is wired with:
 *  - `identityLookup` → Sprint 1 IdentityManager (subject's current public identity)
 *  - `deviceLookup`   → Sprint 2 device repository (device-fingerprint change detection)
 */

import { TrustManager } from "../trust/manager/trustManager.js";
import { createMongoTrustRepositories } from "../trust/repository/mongoRepository.js";
import { TrustError } from "../trust/errors.js";
import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { IdentityError } from "../identity/errors.js";
import { createMongoDeviceRepository } from "../device-trust/repository/mongoRepository.js";

const identityManager = new IdentityManager(createMongoRepositories());
const deviceRepo = createMongoDeviceRepository().devices;

const trustManager = new TrustManager({
  ...createMongoTrustRepositories(),
  identityLookup: (userId) => identityManager.getIdentityByUser(userId),
  deviceLookup: async (userId) => (await deviceRepo.findByUser(userId)).map((d) => d.fingerprint),
});

function handleError(res, error, where) {
  if (error instanceof TrustError || error instanceof IdentityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** GET /api/trust/users/:userId/fingerprint */
export const getUserFingerprint = async (req, res) => {
  try {
    const fingerprint = await trustManager.getFingerprint(req.params.userId);
    return res.status(200).json({ success: true, userId: req.params.userId, fingerprint });
  } catch (error) {
    return handleError(res, error, "getUserFingerprint");
  }
};

/** GET /api/trust/users/:userId/safety-number — between the caller and :userId */
export const getSafetyNumber = async (req, res) => {
  try {
    const result = await trustManager.getSafetyNumber(req.user._id, req.params.userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getSafetyNumber");
  }
};

/** POST /api/trust/verify — Body: { subjectUserId, method?, expectedSafetyNumber?, expectedFingerprint? } */
export const verifyIdentity = async (req, res) => {
  try {
    const { subjectUserId, method, expectedSafetyNumber, expectedFingerprint } = req.body ?? {};
    const verification = await trustManager.verifyIdentity(req.user._id, subjectUserId, {
      method,
      expectedSafetyNumber,
      expectedFingerprint,
    });
    return res.status(200).json({ success: true, verification });
  } catch (error) {
    return handleError(res, error, "verifyIdentity");
  }
};

/** POST /api/trust/verify-qr — Body: { payload } (scanned QR string) */
export const verifyViaQr = async (req, res) => {
  try {
    const verification = await trustManager.verifyViaQr(req.user._id, req.body?.payload);
    return res.status(200).json({ success: true, verification });
  } catch (error) {
    return handleError(res, error, "verifyViaQr");
  }
};

/** POST /api/trust/initiate — Body: { subjectUserId } */
export const initiateVerification = async (req, res) => {
  try {
    const verification = await trustManager.initiateVerification(req.user._id, req.body?.subjectUserId);
    return res.status(201).json({ success: true, verification });
  } catch (error) {
    return handleError(res, error, "initiateVerification");
  }
};

/** POST /api/trust/trust — Body: { subjectUserId } */
export const trustIdentity = async (req, res) => {
  try {
    const verification = await trustManager.trustIdentity(req.user._id, req.body?.subjectUserId);
    return res.status(200).json({ success: true, verification });
  } catch (error) {
    return handleError(res, error, "trustIdentity");
  }
};

/** POST /api/trust/untrust — Body: { subjectUserId } */
export const untrustIdentity = async (req, res) => {
  try {
    const verification = await trustManager.untrustIdentity(req.user._id, req.body?.subjectUserId);
    return res.status(200).json({ success: true, verification });
  } catch (error) {
    return handleError(res, error, "untrustIdentity");
  }
};

/** GET /api/trust/verifications — list the caller's verifications */
export const listVerifications = async (req, res) => {
  try {
    return res.status(200).json({ success: true, verifications: await trustManager.listVerifications(req.user._id) });
  } catch (error) {
    return handleError(res, error, "listVerifications");
  }
};

/** GET /api/trust/users/:userId/status — verification status (with change detection) */
export const getVerificationStatus = async (req, res) => {
  try {
    const status = await trustManager.getVerificationStatus(req.user._id, req.params.userId);
    return res.status(200).json({ success: true, ...status });
  } catch (error) {
    return handleError(res, error, "getVerificationStatus");
  }
};

/** GET /api/trust/users/:userId/history — identity change history for :userId */
export const getIdentityHistory = async (req, res) => {
  try {
    const history = await trustManager.getIdentityHistory(req.params.userId);
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getIdentityHistory");
  }
};

/** GET /api/trust/changes — the caller's verifications with active warnings */
export const getChanges = async (req, res) => {
  try {
    return res.status(200).json({ success: true, changes: await trustManager.getChanges(req.user._id) });
  } catch (error) {
    return handleError(res, error, "getChanges");
  }
};

/** GET /api/trust/me/qr — the caller's own QR verification payload */
export const getMyQrPayload = async (req, res) => {
  try {
    const { serialized, payload } = await trustManager.generateQrPayload(req.user._id);
    return res.status(200).json({ success: true, qr: serialized, payload });
  } catch (error) {
    return handleError(res, error, "getMyQrPayload");
  }
};

/** GET /api/trust/users/:userId/qr — a QR verification payload for :userId */
export const getUserQrPayload = async (req, res) => {
  try {
    const { serialized, payload } = await trustManager.generateQrPayload(req.params.userId);
    return res.status(200).json({ success: true, qr: serialized, payload });
  } catch (error) {
    return handleError(res, error, "getUserQrPayload");
  }
};

/** POST /api/trust/qr/validate — Body: { payload }; validate a scanned QR string */
export const validateQr = async (req, res) => {
  try {
    const payload = trustManager.validateQrPayload(req.body?.payload);
    return res.status(200).json({ success: true, payload });
  } catch (error) {
    return handleError(res, error, "validateQr");
  }
};

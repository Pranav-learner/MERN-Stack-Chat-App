/**
 * @module routes/trustRoute
 *
 * Trust API routes (Layer 3, Sprint 3), mounted at `/api/trust`. Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware — trust is additive;
 * JWT is unchanged. No private keys are accepted or returned.
 *
 * Static paths are declared before `/users/:userId/*` param routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  getUserFingerprint,
  getSafetyNumber,
  verifyIdentity,
  verifyViaQr,
  initiateVerification,
  trustIdentity,
  untrustIdentity,
  listVerifications,
  getVerificationStatus,
  getIdentityHistory,
  getChanges,
  getMyQrPayload,
  getUserQrPayload,
  validateQr,
} from "../controllers/trustController.js";

const trustRouter = express.Router();

// Verification actions.
trustRouter.post("/initiate", protectedRoute, initiateVerification);
trustRouter.post("/verify", protectedRoute, verifyIdentity);
trustRouter.post("/verify-qr", protectedRoute, verifyViaQr);
trustRouter.post("/trust", protectedRoute, trustIdentity);
trustRouter.post("/untrust", protectedRoute, untrustIdentity);

// Queries.
trustRouter.get("/verifications", protectedRoute, listVerifications);
trustRouter.get("/changes", protectedRoute, getChanges);
trustRouter.get("/me/qr", protectedRoute, getMyQrPayload);
trustRouter.post("/qr/validate", protectedRoute, validateQr);

// Per-user (subject) routes.
trustRouter.get("/users/:userId/fingerprint", protectedRoute, getUserFingerprint);
trustRouter.get("/users/:userId/safety-number", protectedRoute, getSafetyNumber);
trustRouter.get("/users/:userId/status", protectedRoute, getVerificationStatus);
trustRouter.get("/users/:userId/history", protectedRoute, getIdentityHistory);
trustRouter.get("/users/:userId/qr", protectedRoute, getUserQrPayload);

export default trustRouter;

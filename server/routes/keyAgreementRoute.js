/**
 * @module routes/keyAgreementRoute
 *
 * Secure Key Agreement API routes (Layer 4, Sprint 2), mounted at
 * `/api/key-agreement`. Every route is protected by the EXISTING `protectedRoute`
 * JWT middleware — key agreement is additive; JWT is unchanged.
 *
 * The server is a RELAY: these endpoints move PUBLIC ephemeral keys and one-way
 * commitments between devices and report status. They NEVER accept or return a
 * private key or a shared secret. Static paths precede `/:id/*` param routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  negotiate,
  submitKey,
  getPeerKey,
  submitCommitment,
  getExchange,
  getMaterialStatus,
  listExchanges,
  getCapabilities,
} from "../controllers/keyAgreementController.js";

const keyAgreementRouter = express.Router();

// Collection + capabilities.
keyAgreementRouter.get("/capabilities", protectedRoute, getCapabilities);
keyAgreementRouter.get("/", protectedRoute, listExchanges);

// Per-handshake key-agreement lifecycle.
keyAgreementRouter.post("/:id/negotiate", protectedRoute, negotiate);
keyAgreementRouter.post("/:id/keys", protectedRoute, submitKey);
keyAgreementRouter.get("/:id/peer-key", protectedRoute, getPeerKey);
keyAgreementRouter.post("/:id/commitment", protectedRoute, submitCommitment);
keyAgreementRouter.get("/:id/material-status", protectedRoute, getMaterialStatus);
keyAgreementRouter.get("/:id", protectedRoute, getExchange);

export default keyAgreementRouter;

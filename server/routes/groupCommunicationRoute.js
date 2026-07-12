/**
 * @module routes/groupCommunicationRoute
 *
 * Group Communication Engine API routes (Layer 10, Sprint 2), mounted at `/api/group-communication`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user is
 * the acting caller/sender.
 *
 * This surface delivers secure group messaging, group key management + membership rekeying, fan-out,
 * group synchronization, and offline-member support on the Sprint-1 Group Foundation. It reuses Layer 5
 * (keys), Layer 8 (reliable messaging), and Layer 9 (synchronization), and carries key METADATA +
 * OPAQUE ciphertext ONLY (no keys/plaintext). It does NOT implement monitoring/hardening (Sprint 3) or
 * read receipts (Sprint 4). Static paths precede the `:groupId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  establishGroupKey,
  rotateGroupKey,
  listKeys,
  getKeyVersion,
  getKeyAudit,
  sweepExpiredKeys,
  sendGroupMessage,
  listMessages,
  getMessage,
  receiveGroupMessage,
  getFanoutPlan,
  getDeliveryStatus,
  fanoutDiagnostics,
  resumeDelivery,
  getPendingMembers,
  synchronizeGroup,
  registerReplica,
  listReplicas,
  getReplica,
  health,
} from "../controllers/groupCommunicationController.js";

const groupCommunicationRouter = express.Router();

// --- observability ----------------------------------------------------------
groupCommunicationRouter.get("/health", protectedRoute, health);

// --- keys + rekey -----------------------------------------------------------
groupCommunicationRouter.post("/groups/:groupId/keys/establish", protectedRoute, establishGroupKey);
groupCommunicationRouter.post("/groups/:groupId/keys/rotate", protectedRoute, rotateGroupKey);
groupCommunicationRouter.get("/groups/:groupId/keys", protectedRoute, listKeys);
groupCommunicationRouter.get("/groups/:groupId/keys/version", protectedRoute, getKeyVersion);
groupCommunicationRouter.get("/groups/:groupId/keys/audit", protectedRoute, getKeyAudit);
groupCommunicationRouter.post("/groups/:groupId/keys/sweep", protectedRoute, sweepExpiredKeys);

// --- messaging + fan-out ----------------------------------------------------
groupCommunicationRouter.post("/groups/:groupId/messages", protectedRoute, sendGroupMessage);
groupCommunicationRouter.get("/groups/:groupId/messages", protectedRoute, listMessages);
groupCommunicationRouter.get("/groups/:groupId/messages/:messageId", protectedRoute, getMessage);
groupCommunicationRouter.post("/groups/:groupId/messages/:messageId/receive", protectedRoute, receiveGroupMessage);
groupCommunicationRouter.get("/groups/:groupId/messages/:messageId/fanout", protectedRoute, getFanoutPlan);
groupCommunicationRouter.get("/groups/:groupId/messages/:messageId/delivery", protectedRoute, getDeliveryStatus);
groupCommunicationRouter.get("/groups/:groupId/fanout/diagnostics", protectedRoute, fanoutDiagnostics);

// --- offline support --------------------------------------------------------
groupCommunicationRouter.post("/groups/:groupId/resume", protectedRoute, resumeDelivery);
groupCommunicationRouter.get("/groups/:groupId/pending", protectedRoute, getPendingMembers);

// --- synchronization + replicas ---------------------------------------------
groupCommunicationRouter.post("/groups/:groupId/sync", protectedRoute, synchronizeGroup);
groupCommunicationRouter.post("/groups/:groupId/replicas", protectedRoute, registerReplica);
groupCommunicationRouter.get("/groups/:groupId/replicas", protectedRoute, listReplicas);
groupCommunicationRouter.get("/groups/:groupId/replicas/:deviceId", protectedRoute, getReplica);

export default groupCommunicationRouter;

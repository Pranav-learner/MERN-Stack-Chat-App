/**
 * @module routes/groupReceiptRoute
 *
 * Group Delivery Intelligence & Receipt Aggregation API routes (Layer 10, Sprint 4), mounted at
 * `/api/group-receipts`. Every route is protected by the EXISTING `protectedRoute` JWT middleware; a
 * member reports only their own delivery/read.
 *
 * This subsystem tracks per-member delivery + read state, aggregates them incrementally, and serves
 * WhatsApp-style receipts (✓ / ✓✓ / ✓✓-blue) + analytics. It carries NO message content or keys, and is
 * INDEPENDENT of the messaging / fan-out / synchronization architecture (which it consumes via events).
 * Static/observability paths precede the `:messageId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerMessage,
  trackDelivery,
  trackRead,
  getReceipt,
  getReaders,
  getPendingMembers,
  getOfflineMembers,
  getMemberReceipt,
  getAnalytics,
  getDeliveryStats,
  getReadStats,
  getDiagnostics,
  listGroupReceipts,
  health,
} from "../controllers/groupReceiptController.js";

const groupReceiptRouter = express.Router();

// --- observability + collection ---------------------------------------------
groupReceiptRouter.get("/health", protectedRoute, health);
groupReceiptRouter.post("/messages", protectedRoute, registerMessage);
groupReceiptRouter.get("/groups/:groupId/receipts", protectedRoute, listGroupReceipts);

// --- per-member tracking ----------------------------------------------------
groupReceiptRouter.post("/messages/:messageId/delivered", protectedRoute, trackDelivery);
groupReceiptRouter.post("/messages/:messageId/read", protectedRoute, trackRead);

// --- receipt reads ----------------------------------------------------------
groupReceiptRouter.get("/messages/:messageId", protectedRoute, getReceipt);
groupReceiptRouter.get("/messages/:messageId/readers", protectedRoute, getReaders);
groupReceiptRouter.get("/messages/:messageId/pending", protectedRoute, getPendingMembers);
groupReceiptRouter.get("/messages/:messageId/offline", protectedRoute, getOfflineMembers);
groupReceiptRouter.get("/messages/:messageId/member/:memberId", protectedRoute, getMemberReceipt);

// --- analytics + diagnostics ------------------------------------------------
groupReceiptRouter.get("/messages/:messageId/analytics", protectedRoute, getAnalytics);
groupReceiptRouter.get("/messages/:messageId/delivery-stats", protectedRoute, getDeliveryStats);
groupReceiptRouter.get("/messages/:messageId/read-stats", protectedRoute, getReadStats);
groupReceiptRouter.get("/messages/:messageId/diagnostics", protectedRoute, getDiagnostics);

export default groupReceiptRouter;

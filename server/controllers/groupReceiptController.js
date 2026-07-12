/**
 * @module controllers/groupReceiptController
 *
 * HTTP handlers for the **Group Delivery Intelligence** subsystem (Layer 10, Sprint 4), mounted at
 * `/api/group-receipts`. It tracks per-member delivery + read state, aggregates them incrementally, and
 * serves WhatsApp-style receipts (✓ / ✓✓ / ✓✓-blue) + analytics for group messages.
 *
 * This is an INDEPENDENT subsystem the Group Communication Engine consumes: it is auto-driven by the
 * Sprint-2 `group-comm.delivery_updated` + `group-comm.message_received` events (once a message is
 * registered for tracking), and also exposes explicit register/track endpoints. Every route is
 * JWT-protected; a member reports only their OWN delivery/read (`memberId = caller`) — you can't spoof
 * someone else's read.
 *
 * @security Reasons over delivery control-plane metadata ONLY — no message content or keys. The server
 * wiring maps a Sprint-2 device id to a member id with the identity resolver (the engine's default
 * treats each member as one logical device); a deployment injects a real device→member resolver.
 */

import { GroupReceiptManager } from "../group-receipts/manager/groupReceiptManager.js";
import { createReceiptApi } from "../group-receipts/api/receiptApi.js";
import { createMongoReceiptRepository } from "../group-receipts/repository/mongoReceiptRepository.js";
import { ReceiptCache } from "../group-receipts/cache/receiptCache.js";
import { GroupReceiptEventBus } from "../group-receipts/events/events.js";
import { GroupReceiptError } from "../group-receipts/errors.js";
import { groupCommEvents } from "./groupCommunicationController.js";

/** Shared receipt event bus. A future dashboard subscribes here. */
export const groupReceiptEvents = new GroupReceiptEventBus();

/** Process-wide Group Receipt Manager over the Mongo-backed repository + a TTL/LRU cache. */
export const groupReceiptManager = new GroupReceiptManager({ ...createMongoReceiptRepository(), events: groupReceiptEvents, cache: new ReceiptCache() });

/** The stable facade the HTTP handlers delegate to. */
export const groupReceiptApi = createReceiptApi(groupReceiptManager);

/**
 * Auto-drive receipts from the Sprint-2 Group Communication events. The engine's default treats each
 * member as one logical device, so device id === member id (identity resolver). This keeps the receipt
 * subsystem independent — Sprint 2 is never modified.
 */
groupReceiptManager.attachToGroupComm(groupCommEvents, { resolveMember: (deviceId) => String(deviceId).replace(/-d$/, "") });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof GroupReceiptError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

// === registration + tracking ================================================

/** POST /messages — register a group message for receipt tracking. Body: { messageId, groupId, applicableMembers, policy?, readExcludedMembers? }. */
export const registerMessage = async (req, res) => {
  try {
    const receipt = await groupReceiptApi.registerMessage({ senderId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, receipt });
  } catch (error) {
    return handleError(res, error, "registerMessage");
  }
};

/** POST /messages/:messageId/delivered — report delivery to the caller's device. Body: { deviceId?, status? }. */
export const trackDelivery = async (req, res) => {
  try {
    const member = await groupReceiptApi.trackDelivery({ messageId: req.params.messageId, memberId: callerId(req), deviceId: req.body?.deviceId ?? callerId(req), status: req.body?.status, deviceMeta: req.body?.deviceMeta });
    return res.status(200).json({ success: true, member });
  } catch (error) {
    return handleError(res, error, "trackDelivery");
  }
};

/** POST /messages/:messageId/read — report a read by the caller's device. Body: { deviceId? }. */
export const trackRead = async (req, res) => {
  try {
    const member = await groupReceiptApi.trackRead({ messageId: req.params.messageId, memberId: callerId(req), deviceId: req.body?.deviceId ?? callerId(req) });
    return res.status(200).json({ success: true, member });
  } catch (error) {
    return handleError(res, error, "trackRead");
  }
};

// === receipt reads ==========================================================

/** GET /messages/:messageId — the receipt status (tick + counts). */
export const getReceipt = async (req, res) => {
  try {
    const receipt = await groupReceiptApi.getReceipt({ messageId: req.params.messageId });
    return res.status(200).json({ success: true, receipt });
  } catch (error) {
    return handleError(res, error, "getReceipt");
  }
};

/** GET /messages/:messageId/readers — members who have read (?limit=&offset=). */
export const getReaders = async (req, res) => {
  try {
    const result = await groupReceiptApi.getReaders({ messageId: req.params.messageId, limit: req.query.limit ? Number(req.query.limit) : undefined, offset: req.query.offset ? Number(req.query.offset) : undefined });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getReaders");
  }
};

/** GET /messages/:messageId/pending — members not yet delivered (?limit=&offset=). */
export const getPendingMembers = async (req, res) => {
  try {
    const result = await groupReceiptApi.getPendingMembers({ messageId: req.params.messageId, limit: req.query.limit ? Number(req.query.limit) : undefined, offset: req.query.offset ? Number(req.query.offset) : undefined });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getPendingMembers");
  }
};

/** GET /messages/:messageId/offline — pending members currently offline. */
export const getOfflineMembers = async (req, res) => {
  try {
    const result = await groupReceiptApi.getOfflineMembers({ messageId: req.params.messageId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getOfflineMembers");
  }
};

/** GET /messages/:messageId/member/:memberId — a single member's receipt. */
export const getMemberReceipt = async (req, res) => {
  try {
    const member = await groupReceiptApi.getMemberReceipt({ messageId: req.params.messageId, memberId: req.params.memberId });
    return res.status(200).json({ success: true, member });
  } catch (error) {
    return handleError(res, error, "getMemberReceipt");
  }
};

// === analytics + diagnostics ================================================

/** GET /messages/:messageId/analytics — full delivery/read analytics. */
export const getAnalytics = async (req, res) => {
  try {
    const analytics = await groupReceiptApi.getAnalytics({ messageId: req.params.messageId, computeOffline: req.query.offline === "1" });
    return res.status(200).json({ success: true, analytics });
  } catch (error) {
    return handleError(res, error, "getAnalytics");
  }
};

/** GET /messages/:messageId/delivery-stats — delivery statistics. */
export const getDeliveryStats = async (req, res) => {
  try {
    const stats = await groupReceiptApi.getDeliveryStats({ messageId: req.params.messageId });
    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return handleError(res, error, "getDeliveryStats");
  }
};

/** GET /messages/:messageId/read-stats — read statistics. */
export const getReadStats = async (req, res) => {
  try {
    const stats = await groupReceiptApi.getReadStats({ messageId: req.params.messageId });
    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return handleError(res, error, "getReadStats");
  }
};

/** GET /messages/:messageId/diagnostics — receipt diagnostics (aggregate + cache). */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await groupReceiptApi.getDiagnostics({ messageId: req.params.messageId });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /groups/:groupId/receipts — recent receipts for a group (dashboard). */
export const listGroupReceipts = async (req, res) => {
  try {
    const receipts = await groupReceiptApi.listGroupReceipts({ groupId: req.params.groupId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, receipts });
  } catch (error) {
    return handleError(res, error, "listGroupReceipts");
  }
};

/** GET /health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await groupReceiptApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/**
 * @module controllers/groupCommunicationController
 *
 * HTTP handlers for the **Group Communication Engine** (Layer 10, Sprint 2), mounted at
 * `/api/group-communication`. This surface delivers secure group messaging, group key management +
 * membership rekeying, fan-out, group synchronization, and offline-member support on top of the
 * Sprint-1 Group Foundation.
 *
 * The engine is wired to reuse earlier layers:
 *  - **membership directory** ← the Sprint-1 `groupManager` (who is in the group);
 *  - **fan-out transport** ← a Layer 8-style `messagingSend` relay hook (the server hands ciphertext to
 *    the reliable-messaging plane and marks legs DISPATCHED; recipient devices confirm via `/receive`);
 *  - keys reuse the Layer 5 HKDF primitives (device-local); sync reuses the Layer 9 delta model.
 *
 * Every route is JWT-protected; `req.user._id` is the acting caller/sender. The engine is a BLIND relay:
 * it stores key METADATA (fingerprints/versions) + OPAQUE ciphertext only — never keys or plaintext.
 *
 * @note A deployment injects real multi-device + presence resolvers; the defaults here treat each member
 * as one logical device and rely on explicit reconnect (`/resume`) for offline recovery, keeping the
 * subsystem transport-independent (Sprint 3 hardens presence integration).
 */

import { GroupCommunicationEngine, createGroupDirectoryFromManager } from "../group-communication/manager/groupCommunicationEngine.js";
import { createGroupCommunicationApi } from "../group-communication/api/groupCommunicationApi.js";
import { createMongoGroupCommRepository } from "../group-communication/repository/mongoGroupCommRepository.js";
import { GroupCommEventBus } from "../group-communication/events/events.js";
import { GroupCommError } from "../group-communication/errors.js";
import { groupManager } from "./groupManagementController.js";

/** Shared group-communication event bus. A future Sprint 4 (read receipts) subscribes here. */
export const groupCommEvents = new GroupCommEventBus();

/**
 * Server fan-out relay: hands opaque ciphertext to the reliable-messaging plane. Returns `delivered:false`
 * so the leg stays DISPATCHED (in-flight) until the recipient device confirms via `/receive` — the
 * correct blind-relay semantics. A deployment swaps this for a real Layer 8 `DataPlaneService.send`.
 */
const messagingSend = async () => ({ message: { messageId: null }, delivered: false });

/** Process-wide Group Communication Engine over the Mongo-backed repository + Sprint-1 directory. */
export const groupCommEngine = new GroupCommunicationEngine({
  ...createMongoGroupCommRepository(),
  events: groupCommEvents,
  directory: createGroupDirectoryFromManager(groupManager),
  messagingSend,
});

/** The stable facade the HTTP handlers delegate to. */
export const groupCommApi = createGroupCommunicationApi(groupCommEngine);

const callerId = (req) => String(req.user._id);
const gid = (req) => req.params.groupId;

function handleError(res, error, where) {
  if (error instanceof GroupCommError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

// === keys + rekey ===========================================================

/** POST /groups/:groupId/keys/establish — establish the initial group key. Body: { fingerprint?, ttlMs? }. */
export const establishGroupKey = async (req, res) => {
  try {
    const key = await groupCommApi.establishGroupKey({ groupId: gid(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, key });
  } catch (error) {
    return handleError(res, error, "establishGroupKey");
  }
};

/** POST /groups/:groupId/keys/rotate — rotate the group key. Body: { trigger, fingerprint?, affectedMember?, ttlMs? }. */
export const rotateGroupKey = async (req, res) => {
  try {
    const key = await groupCommApi.rotateGroupKey({ groupId: gid(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, key });
  } catch (error) {
    return handleError(res, error, "rotateGroupKey");
  }
};

/** GET /groups/:groupId/keys — all key versions. */
export const listKeys = async (req, res) => {
  try {
    return res.status(200).json({ success: true, keys: await groupCommApi.listKeys({ groupId: gid(req) }) });
  } catch (error) {
    return handleError(res, error, "listKeys");
  }
};

/** GET /groups/:groupId/keys/version — the current key version. */
export const getKeyVersion = async (req, res) => {
  try {
    return res.status(200).json({ success: true, ...(await groupCommApi.getKeyVersion({ groupId: gid(req) })) });
  } catch (error) {
    return handleError(res, error, "getKeyVersion");
  }
};

/** GET /groups/:groupId/keys/audit — key audit trail (?limit=). */
export const getKeyAudit = async (req, res) => {
  try {
    const audit = await groupCommApi.getKeyAudit({ groupId: gid(req), limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, audit });
  } catch (error) {
    return handleError(res, error, "getKeyAudit");
  }
};

/** POST /groups/:groupId/keys/sweep — expire past-TTL keys. */
export const sweepExpiredKeys = async (req, res) => {
  try {
    return res.status(200).json({ success: true, ...(await groupCommApi.sweepExpiredKeys({ groupId: gid(req) })) });
  } catch (error) {
    return handleError(res, error, "sweepExpiredKeys");
  }
};

// === messaging + fan-out ====================================================

/** POST /groups/:groupId/messages — send an encrypted group message. Body: { ciphertext, senderDeviceId?, keyVersion?, priority?, metadata? }. */
export const sendGroupMessage = async (req, res) => {
  try {
    const result = await groupCommApi.sendGroupMessage({ groupId: gid(req), senderId: callerId(req), senderDeviceId: req.body?.senderDeviceId ?? callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "sendGroupMessage");
  }
};

/** GET /groups/:groupId/messages — recent group messages (metadata only). */
export const listMessages = async (req, res) => {
  try {
    const messages = await groupCommApi.listMessages({ groupId: gid(req), limit: req.query.limit ? Number(req.query.limit) : undefined, offset: req.query.offset ? Number(req.query.offset) : undefined });
    return res.status(200).json({ success: true, messages });
  } catch (error) {
    return handleError(res, error, "listMessages");
  }
};

/** GET /groups/:groupId/messages/:messageId — one message (?ciphertext=1 to include the payload). */
export const getMessage = async (req, res) => {
  try {
    const message = await groupCommApi.getMessage({ groupId: gid(req), messageId: req.params.messageId, includeCiphertext: req.query.ciphertext === "1" || req.query.ciphertext === "true" });
    return res.status(200).json({ success: true, message });
  } catch (error) {
    return handleError(res, error, "getMessage");
  }
};

/** POST /groups/:groupId/messages/:messageId/receive — confirm receipt on a device. Body: { deviceId }. */
export const receiveGroupMessage = async (req, res) => {
  try {
    const result = await groupCommApi.receiveGroupMessage({ groupId: gid(req), messageId: req.params.messageId, deviceId: req.body?.deviceId ?? callerId(req), memberId: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "receiveGroupMessage");
  }
};

/** GET /groups/:groupId/messages/:messageId/fanout — the message's fan-out plan. */
export const getFanoutPlan = async (req, res) => {
  try {
    const fanout = await groupCommApi.getFanoutPlan({ messageId: req.params.messageId });
    return res.status(200).json({ success: true, fanout });
  } catch (error) {
    return handleError(res, error, "getFanoutPlan");
  }
};

/** GET /groups/:groupId/messages/:messageId/delivery — the message's delivery status. */
export const getDeliveryStatus = async (req, res) => {
  try {
    const delivery = await groupCommApi.getDeliveryStatus({ groupId: gid(req), messageId: req.params.messageId });
    return res.status(200).json({ success: true, delivery });
  } catch (error) {
    return handleError(res, error, "getDeliveryStatus");
  }
};

/** GET /groups/:groupId/fanout/diagnostics — fan-out roll-up. */
export const fanoutDiagnostics = async (req, res) => {
  try {
    const diagnostics = await groupCommApi.fanoutDiagnostics({ groupId: gid(req), limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "fanoutDiagnostics");
  }
};

// === offline support ========================================================

/** POST /groups/:groupId/resume — resume deferred deliveries for a reconnected device. Body: { deviceId }. */
export const resumeDelivery = async (req, res) => {
  try {
    const result = await groupCommApi.resumeDelivery({ groupId: gid(req), deviceId: req.body?.deviceId ?? callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resumeDelivery");
  }
};

/** GET /groups/:groupId/pending — members with queued deliveries. */
export const getPendingMembers = async (req, res) => {
  try {
    const pending = await groupCommApi.getPendingMembers({ groupId: gid(req) });
    return res.status(200).json({ success: true, pending });
  } catch (error) {
    return handleError(res, error, "getPendingMembers");
  }
};

// === synchronization + replicas =============================================

/** POST /groups/:groupId/sync — synchronize a device's replica. Body: { deviceId, memberId?, replica? }. */
export const synchronizeGroup = async (req, res) => {
  try {
    const result = await groupCommApi.synchronizeGroup({ groupId: gid(req), deviceId: req.body?.deviceId ?? callerId(req), memberId: callerId(req), replica: req.body?.replica });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "synchronizeGroup");
  }
};

/** POST /groups/:groupId/replicas — register/refresh a device replica. Body: { deviceId, facetVersions?, keyVersion? }. */
export const registerReplica = async (req, res) => {
  try {
    const replica = await groupCommApi.registerReplica({ groupId: gid(req), deviceId: req.body?.deviceId ?? callerId(req), memberId: callerId(req), facetVersions: req.body?.facetVersions, keyVersion: req.body?.keyVersion });
    return res.status(201).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "registerReplica");
  }
};

/** GET /groups/:groupId/replicas — all replicas (diagnostics). */
export const listReplicas = async (req, res) => {
  try {
    return res.status(200).json({ success: true, replicas: await groupCommApi.listReplicas({ groupId: gid(req) }) });
  } catch (error) {
    return handleError(res, error, "listReplicas");
  }
};

/** GET /groups/:groupId/replicas/:deviceId — one device's replica. */
export const getReplica = async (req, res) => {
  try {
    const replica = await groupCommApi.getReplica({ groupId: gid(req), deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "getReplica");
  }
};

/** GET /health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await groupCommApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

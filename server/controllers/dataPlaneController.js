/**
 * @module controllers/dataPlaneController
 *
 * HTTP handlers for the **Reliable P2P Messaging** data plane (Layer 8, Sprint 1), mounted at
 * `/api/data-plane`. The server runs as a BLIND store-and-forward relay: a sender device relays an
 * already-encrypted message, the receiver device pulls it and ACKs it, and both sides read delivery
 * status/history/diagnostics. The engine itself runs PEER-TO-PEER on the client over a Layer-7 Active
 * Connection; this relay is the coordination path when there is no direct link.
 *
 * @security The server NEVER decrypts. It validates the no-plaintext invariant, persists OPAQUE
 * ciphertext + delivery metadata only, and holds no key material. Every route is JWT-protected; the
 * authenticated `req.user._id` is the acting device (sender for relays/status, receiver for
 * inbox/ack). Ownership is enforced in the relay service.
 *
 * @scope Transports encrypted application messages only. NO file transfer, chunking, fragmentation,
 * streaming, or media — that is Layer 8, Sprint 2.
 */

import { createDataPlaneRelayService } from "../data-plane/api/relayService.js";
import { createMongoMessageRepository } from "../data-plane/repository/mongoMessageRepository.js";
import { MessagingEventBus } from "../data-plane/events/events.js";
import { DataPlaneError } from "../data-plane/errors.js";

/** Shared data-plane event bus (a future Sprint 2 / observability layer subscribes here). */
export const dataPlaneEvents = new MessagingEventBus();

/** Process-wide blind relay over the Mongo-backed data-plane repository. */
export const dataPlaneRelay = createDataPlaneRelayService({
  repository: createMongoMessageRepository(),
  events: dataPlaneEvents,
});

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof DataPlaneError) {
    return res.status(error.status ?? 400).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/data-plane/relay — a sender relays an encrypted message. Body: { conversationId, receiverDeviceId, encryptedPayload, priority?, ttlMs?, connectionId? }. */
export const relay = async (req, res) => {
  try {
    const message = await dataPlaneRelay.relay({ actingDevice: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, message });
  } catch (error) {
    return handleError(res, error, "relay");
  }
};

/** GET /api/data-plane/inbox/:conversationId — the receiver pulls its undelivered messages (with ciphertext). */
export const inbox = async (req, res) => {
  try {
    const messages = await dataPlaneRelay.inbox({ actingDevice: callerId(req), conversationId: req.params.conversationId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, messages });
  } catch (error) {
    return handleError(res, error, "inbox");
  }
};

/** POST /api/data-plane/:messageId/ack — the receiver acknowledges a delivered message. */
export const acknowledge = async (req, res) => {
  try {
    const message = await dataPlaneRelay.acknowledge({ actingDevice: callerId(req), messageId: req.params.messageId });
    return res.status(200).json({ success: true, message });
  } catch (error) {
    return handleError(res, error, "acknowledge");
  }
};

/** GET /api/data-plane/:messageId/status — a sender reads its message's delivery status. */
export const getStatus = async (req, res) => {
  try {
    const status = await dataPlaneRelay.getStatus({ actingDevice: callerId(req), messageId: req.params.messageId });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/data-plane/pending/:conversationId — a sender's still-pending messages. */
export const getPending = async (req, res) => {
  try {
    const pending = await dataPlaneRelay.getPending({ actingDevice: callerId(req), conversationId: req.params.conversationId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, pending });
  } catch (error) {
    return handleError(res, error, "getPending");
  }
};

/** GET /api/data-plane/history/:conversationId — delivery history (metadata only). */
export const getHistory = async (req, res) => {
  try {
    const history = await dataPlaneRelay.getHistory({ conversationId: req.params.conversationId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getHistory");
  }
};

/** GET /api/data-plane/diagnostics/:conversationId — aggregate delivery diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await dataPlaneRelay.getDiagnostics({ conversationId: req.params.conversationId });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/data-plane/status — the relay's posture (server never decrypts). */
export const relayStatus = async (_req, res) => {
  return res.status(200).json({
    success: true,
    status: {
      role: "relay",
      canDecrypt: false,
      layer: "8.1",
      capabilities: ["reliable-delivery", "ordering", "acknowledgement", "retransmission", "duplicate-detection", "store-and-forward"],
      note: "The server relays and stores ciphertext only; the reliable-messaging engine runs peer-to-peer on the client.",
    },
  });
};

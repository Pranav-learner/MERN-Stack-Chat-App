/**
 * @module controllers/transportEngineController
 *
 * HTTP handlers for the **Large Payload Transport Engine** (Layer 8, Sprint 2), mounted at
 * `/api/transport-engine`. The server runs as a BLIND chunk relay: a sender opens a transfer + relays
 * its opaque ciphertext chunks; the receiver pulls the chunks (store-and-forward) and acknowledges
 * them; both read progress/diagnostics. The fragmentation / flow-control / reassembly engine runs
 * PEER-TO-PEER on the client; this relay is the coordination path when there is no direct link.
 *
 * @security The server NEVER decrypts. It verifies only chunk INTEGRITY checksums (over ciphertext),
 * persists opaque fragments + metadata, holds no key material, and returns metadata DTOs (opaque chunk
 * data only on an explicit receiver inbox pull). Every route is JWT-protected; `req.user._id` is the
 * acting device. Ownership is enforced in the relay service.
 *
 * @scope Large ENCRYPTED payloads (files, images, videos, voice notes, documents, binary). NO voice
 * calls, video calls, or live streaming — that is Layer 11.
 */

import { createTransportRelayService } from "../transport-engine/api/relayService.js";
import { createMongoTransportRepository } from "../transport-engine/repository/mongoTransportRepository.js";
import { TransportEventBus } from "../transport-engine/events/events.js";
import { TransportEngineError } from "../transport-engine/errors.js";

/** Shared transport-engine event bus (a future Layer 11 / observability layer subscribes here). */
export const transportEvents = new TransportEventBus();

/** Process-wide blind relay over the Mongo-backed transport repository. */
export const transportRelay = createTransportRelayService({
  repository: createMongoTransportRepository(),
  events: transportEvents,
});

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof TransportEngineError) {
    return res.status(error.status ?? 400).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/transport-engine/transfers — a sender opens a transfer. Body: { conversationId, receiverDeviceId, payloadMeta, priority? }. */
export const openTransfer = async (req, res) => {
  try {
    const transfer = await transportRelay.openTransfer({ actingDevice: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, transfer });
  } catch (error) {
    return handleError(res, error, "openTransfer");
  }
};

/** POST /api/transport-engine/transfers/:transferId/chunks — a sender relays one opaque chunk. Body: { chunk }. */
export const relayChunk = async (req, res) => {
  try {
    const chunk = await transportRelay.relayChunk({ actingDevice: callerId(req), transferId: req.params.transferId, chunk: req.body?.chunk });
    return res.status(201).json({ success: true, chunk });
  } catch (error) {
    return handleError(res, error, "relayChunk");
  }
};

/** GET /api/transport-engine/transfers/:transferId/inbox — the receiver pulls stored chunks (with opaque data). ?limit. */
export const pullChunks = async (req, res) => {
  try {
    const result = await transportRelay.pullChunks({ actingDevice: callerId(req), transferId: req.params.transferId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "pullChunks");
  }
};

/** POST /api/transport-engine/transfers/:transferId/ack — the receiver acknowledges chunks. Body: { chunkIds }. */
export const ackChunks = async (req, res) => {
  try {
    const result = await transportRelay.ackChunks({ actingDevice: callerId(req), transferId: req.params.transferId, chunkIds: req.body?.chunkIds });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "ackChunks");
  }
};

/** POST /api/transport-engine/transfers/:transferId/pause — pause a transfer. */
export const pauseTransfer = async (req, res) => {
  try {
    const transfer = await transportRelay.pauseTransfer({ actingDevice: callerId(req), transferId: req.params.transferId });
    return res.status(200).json({ success: true, transfer });
  } catch (error) {
    return handleError(res, error, "pauseTransfer");
  }
};

/** POST /api/transport-engine/transfers/:transferId/resume — resume a transfer. */
export const resumeTransfer = async (req, res) => {
  try {
    const transfer = await transportRelay.resumeTransfer({ actingDevice: callerId(req), transferId: req.params.transferId });
    return res.status(200).json({ success: true, transfer });
  } catch (error) {
    return handleError(res, error, "resumeTransfer");
  }
};

/** POST /api/transport-engine/transfers/:transferId/cancel — cancel a transfer. */
export const cancelTransfer = async (req, res) => {
  try {
    const transfer = await transportRelay.cancelTransfer({ actingDevice: callerId(req), transferId: req.params.transferId });
    return res.status(200).json({ success: true, transfer });
  } catch (error) {
    return handleError(res, error, "cancelTransfer");
  }
};

/** GET /api/transport-engine/transfers/:transferId — a transfer's public DTO. */
export const getTransfer = async (req, res) => {
  try {
    const transfer = await transportRelay.getTransfer({ actingDevice: callerId(req), transferId: req.params.transferId });
    return res.status(200).json({ success: true, transfer });
  } catch (error) {
    return handleError(res, error, "getTransfer");
  }
};

/** GET /api/transport-engine/transfers/:transferId/progress — a transfer's progress. */
export const getProgress = async (req, res) => {
  try {
    const progress = await transportRelay.getProgress({ actingDevice: callerId(req), transferId: req.params.transferId });
    return res.status(200).json({ success: true, progress });
  } catch (error) {
    return handleError(res, error, "getProgress");
  }
};

/** GET /api/transport-engine/transfers/:transferId/chunks — chunk statuses (no opaque data). */
export const getChunkStatus = async (req, res) => {
  try {
    const chunks = await transportRelay.getChunkStatus({ transferId: req.params.transferId });
    return res.status(200).json({ success: true, chunks });
  } catch (error) {
    return handleError(res, error, "getChunkStatus");
  }
};

/** GET /api/transport-engine/transfers — the caller's active transfers (?conversationId). */
export const listActiveTransfers = async (req, res) => {
  try {
    const transfers = await transportRelay.listActiveTransfers({ actingDevice: callerId(req), conversationId: req.query.conversationId });
    return res.status(200).json({ success: true, transfers });
  } catch (error) {
    return handleError(res, error, "listActiveTransfers");
  }
};

/** GET /api/transport-engine/diagnostics/:conversationId — aggregate transfer diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await transportRelay.getDiagnostics({ conversationId: req.params.conversationId });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/transport-engine/status — the relay's posture (server never decrypts). */
export const relayStatus = async (_req, res) => {
  return res.status(200).json({
    success: true,
    status: {
      role: "relay",
      canDecrypt: false,
      layer: "8.2",
      capabilities: ["fragmentation", "reassembly", "flow-control", "backpressure", "multiplexing", "priority-scheduling", "store-and-forward"],
      supportedPayloads: ["file", "image", "video", "voice-note", "document", "binary"],
      note: "The server relays + stores opaque ciphertext chunks only; the transport engine (fragmentation, flow control, reassembly) runs peer-to-peer on the client. Live media (voice/video calls, streaming) is Layer 11.",
    },
  });
};

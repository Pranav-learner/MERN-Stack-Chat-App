/**
 * @module controllers/mediaDeliveryController
 *
 * HTTP handlers for the **Distributed Media Delivery & Streaming** subsystem (Layer 11, Sprint 2),
 * mounted at `/api/media-delivery`. It delivers encrypted media efficiently on top of the frozen Sprint-1
 * pipeline: streaming sessions (chunk + seek + pause/resume), progressive downloads/uploads (windowed
 * chunks + resume), async thumbnail/preview generation, multi-device media synchronization, and transfer
 * optimization.
 *
 * The server is a BLIND relay: chunk endpoints return/accept OPAQUE ciphertext (base64) + a per-chunk
 * hash for device-side reassembly + decryption; the server never decrypts or handles keys. Every route
 * is JWT-protected; `req.user._id` is the acting device/owner. It reuses the process-wide Sprint-1
 * `mediaManager` (so it works with whatever storage provider Sprint 1 is configured with).
 */

import { MediaDeliveryEngine } from "../media-delivery/manager/mediaDeliveryEngine.js";
import { createDeliveryApi } from "../media-delivery/api/deliveryApi.js";
import { createMongoDeliveryRepository } from "../media-delivery/repository/mongoDeliveryRepository.js";
import { MediaDeliveryEventBus } from "../media-delivery/events/events.js";
import { MediaDeliveryError } from "../media-delivery/errors.js";
import { mediaManager } from "./mediaController.js";

/** Shared media-delivery event bus. A future Sprint 3 subscribes here. */
export const mediaDeliveryEvents = new MediaDeliveryEventBus();

/** Process-wide Media Delivery Engine over the Mongo-backed delivery repo + the Sprint-1 pipeline. */
export const mediaDeliveryEngine = new MediaDeliveryEngine({ ...createMongoDeliveryRepository(), mediaManager, events: mediaDeliveryEvents });

/** The stable facade the HTTP handlers delegate to. */
export const mediaDeliveryApi = createDeliveryApi(mediaDeliveryEngine);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof MediaDeliveryError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

const wrap = (fn, where) => async (req, res) => {
  try {
    return res.status(where.status ?? 200).json({ success: true, ...(await fn(req)) });
  } catch (error) {
    return handleError(res, error, where.name);
  }
};

// === streaming ==============================================================

export const startStreaming = wrap((req) => mediaDeliveryApi.startStreaming({ actorId: callerId(req), deviceId: req.body?.deviceId ?? callerId(req), ...(req.body ?? {}) }), { name: "startStreaming", status: 201 });
export const streamChunk = wrap((req) => mediaDeliveryApi.streamChunk({ sessionId: req.params.sessionId, index: req.query.index != null ? Number(req.query.index) : undefined, actorId: callerId(req) }), { name: "streamChunk" });
export const seek = wrap((req) => mediaDeliveryApi.seek({ sessionId: req.params.sessionId, index: Number(req.body?.index), actorId: callerId(req) }), { name: "seek" });
export const pauseStreaming = wrap(async (req) => ({ session: await mediaDeliveryApi.pauseStreaming({ sessionId: req.params.sessionId, actorId: callerId(req) }) }), { name: "pauseStreaming" });
export const resumeStreaming = wrap(async (req) => ({ session: await mediaDeliveryApi.resumeStreaming({ sessionId: req.params.sessionId, actorId: callerId(req) }) }), { name: "resumeStreaming" });
export const cancelStreaming = wrap(async (req) => ({ session: await mediaDeliveryApi.cancelStreaming({ sessionId: req.params.sessionId, actorId: callerId(req) }) }), { name: "cancelStreaming" });
export const getStreamingStatus = wrap(async (req) => ({ session: await mediaDeliveryApi.getStreamingStatus({ sessionId: req.params.sessionId }) }), { name: "getStreamingStatus" });

// === progressive transfers ==================================================

export const startTransfer = wrap((req) => mediaDeliveryApi.startTransfer({ actorId: callerId(req), deviceId: req.body?.deviceId ?? callerId(req), ...(req.body ?? {}) }), { name: "startTransfer", status: 201 });
export const fetchChunk = wrap((req) => mediaDeliveryApi.fetchChunk({ transferId: req.params.transferId, index: Number(req.query.index), actorId: callerId(req) }), { name: "fetchChunk" });
export const uploadChunk = wrap((req) => mediaDeliveryApi.uploadChunk({ transferId: req.params.transferId, index: Number(req.body?.index), data: req.body?.data, hash: req.body?.hash, actorId: callerId(req) }), { name: "uploadChunk" });
export const completeUpload = wrap((req) => mediaDeliveryApi.completeUpload({ transferId: req.params.transferId, upload: req.body?.upload, actorId: callerId(req) }), { name: "completeUpload" });
export const resumeTransfer = wrap((req) => mediaDeliveryApi.resumeTransfer({ transferId: req.params.transferId, actorId: callerId(req) }), { name: "resumeTransfer" });
export const pauseTransfer = wrap(async (req) => ({ transfer: await mediaDeliveryApi.pauseTransfer({ transferId: req.params.transferId, actorId: callerId(req) }) }), { name: "pauseTransfer" });
export const cancelTransfer = wrap(async (req) => ({ transfer: await mediaDeliveryApi.cancelTransfer({ transferId: req.params.transferId, actorId: callerId(req) }) }), { name: "cancelTransfer" });
export const getTransferStatus = wrap(async (req) => ({ transfer: await mediaDeliveryApi.getTransferStatus({ transferId: req.params.transferId }) }), { name: "getTransferStatus" });

// === thumbnails + previews ==================================================

export const generateThumbnail = wrap(async (req) => ({ preview: await mediaDeliveryApi.generateThumbnail({ mediaId: req.params.mediaId, kind: req.body?.kind, actorId: callerId(req) }) }), { name: "generateThumbnail", status: 201 });
export const generatePreview = wrap(async (req) => ({ preview: await mediaDeliveryApi.generatePreview({ mediaId: req.params.mediaId, kind: req.body?.kind, actorId: callerId(req) }) }), { name: "generatePreview", status: 201 });
export const getPreview = wrap(async (req) => ({ preview: await mediaDeliveryApi.getPreview({ mediaId: req.params.mediaId, kind: req.query.kind, actorId: callerId(req) }) }), { name: "getPreview" });

// === synchronization ========================================================

export const registerAvailability = wrap(async (req) => ({ replica: await mediaDeliveryApi.registerAvailability({ deviceId: req.body?.deviceId ?? callerId(req), actorId: callerId(req), available: req.body?.available }) }), { name: "registerAvailability" });
export const synchronizeDevice = wrap((req) => mediaDeliveryApi.synchronizeDevice({ deviceId: req.body?.deviceId ?? callerId(req), actorId: callerId(req), authoritativeMedia: req.body?.authoritativeMedia }), { name: "synchronizeDevice" });
export const markMediaAvailable = wrap(async (req) => ({ replica: await mediaDeliveryApi.markMediaAvailable({ deviceId: req.body?.deviceId ?? callerId(req), mediaId: req.params.mediaId, actorId: callerId(req) }) }), { name: "markMediaAvailable" });
export const getOfflineQueue = wrap(async (req) => ({ queue: await mediaDeliveryApi.getOfflineQueue({ deviceId: req.params.deviceId }) }), { name: "getOfflineQueue" });

// === optimization + diagnostics =============================================

export const prefetch = wrap(async (req) => ({ prefetch: await mediaDeliveryApi.prefetch({ candidates: req.body?.candidates }) }), { name: "prefetch" });
export const optimizeTransfers = wrap(() => mediaDeliveryApi.optimizeTransfers(), { name: "optimizeTransfers" });
export const bandwidthMetrics = wrap(async () => ({ bandwidth: await mediaDeliveryApi.bandwidthMetrics() }), { name: "bandwidthMetrics" });
export const getDiagnostics = wrap(async (req) => ({ diagnostics: await mediaDeliveryApi.getDiagnostics({ mediaId: req.params.mediaId }) }), { name: "getDiagnostics" });
export const health = wrap(async () => ({ health: await mediaDeliveryApi.health() }), { name: "health" });

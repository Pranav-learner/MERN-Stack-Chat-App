/**
 * @module routes/mediaDeliveryRoute
 *
 * Distributed Media Delivery & Streaming API routes (Layer 11, Sprint 2), mounted at
 * `/api/media-delivery`. Every route is JWT-protected (`protectedRoute`); the authenticated user is the
 * acting device/owner.
 *
 * Streaming (session + chunk + seek + pause/resume), progressive transfers (download/upload chunks +
 * resume), thumbnails/previews (async), media synchronization, and transfer optimization. Chunk
 * endpoints carry OPAQUE ciphertext + a per-chunk hash; the server never decrypts. Static prefixes
 * precede the `:id` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  startStreaming,
  streamChunk,
  seek,
  pauseStreaming,
  resumeStreaming,
  cancelStreaming,
  getStreamingStatus,
  startTransfer,
  fetchChunk,
  uploadChunk,
  completeUpload,
  resumeTransfer,
  pauseTransfer,
  cancelTransfer,
  getTransferStatus,
  generateThumbnail,
  generatePreview,
  getPreview,
  registerAvailability,
  synchronizeDevice,
  markMediaAvailable,
  getOfflineQueue,
  prefetch,
  optimizeTransfers,
  bandwidthMetrics,
  getDiagnostics,
  health,
} from "../controllers/mediaDeliveryController.js";

const mediaDeliveryRouter = express.Router();

// --- observability + optimization -------------------------------------------
mediaDeliveryRouter.get("/health", protectedRoute, health);
mediaDeliveryRouter.get("/bandwidth", protectedRoute, bandwidthMetrics);
mediaDeliveryRouter.post("/optimize", protectedRoute, optimizeTransfers);
mediaDeliveryRouter.post("/prefetch", protectedRoute, prefetch);

// --- streaming --------------------------------------------------------------
mediaDeliveryRouter.post("/streaming", protectedRoute, startStreaming);
mediaDeliveryRouter.get("/streaming/:sessionId", protectedRoute, getStreamingStatus);
mediaDeliveryRouter.get("/streaming/:sessionId/chunk", protectedRoute, streamChunk);
mediaDeliveryRouter.post("/streaming/:sessionId/seek", protectedRoute, seek);
mediaDeliveryRouter.post("/streaming/:sessionId/pause", protectedRoute, pauseStreaming);
mediaDeliveryRouter.post("/streaming/:sessionId/resume", protectedRoute, resumeStreaming);
mediaDeliveryRouter.post("/streaming/:sessionId/cancel", protectedRoute, cancelStreaming);

// --- progressive transfers --------------------------------------------------
mediaDeliveryRouter.post("/transfers", protectedRoute, startTransfer);
mediaDeliveryRouter.get("/transfers/:transferId", protectedRoute, getTransferStatus);
mediaDeliveryRouter.get("/transfers/:transferId/chunk", protectedRoute, fetchChunk);
mediaDeliveryRouter.post("/transfers/:transferId/chunk", protectedRoute, uploadChunk);
mediaDeliveryRouter.post("/transfers/:transferId/complete", protectedRoute, completeUpload);
mediaDeliveryRouter.post("/transfers/:transferId/resume", protectedRoute, resumeTransfer);
mediaDeliveryRouter.post("/transfers/:transferId/pause", protectedRoute, pauseTransfer);
mediaDeliveryRouter.post("/transfers/:transferId/cancel", protectedRoute, cancelTransfer);

// --- thumbnails + previews --------------------------------------------------
mediaDeliveryRouter.post("/media/:mediaId/thumbnail", protectedRoute, generateThumbnail);
mediaDeliveryRouter.post("/media/:mediaId/preview", protectedRoute, generatePreview);
mediaDeliveryRouter.get("/media/:mediaId/preview", protectedRoute, getPreview);
mediaDeliveryRouter.get("/media/:mediaId/diagnostics", protectedRoute, getDiagnostics);
mediaDeliveryRouter.post("/media/:mediaId/available", protectedRoute, markMediaAvailable);

// --- synchronization --------------------------------------------------------
mediaDeliveryRouter.post("/availability", protectedRoute, registerAvailability);
mediaDeliveryRouter.post("/sync", protectedRoute, synchronizeDevice);
mediaDeliveryRouter.get("/devices/:deviceId/offline-queue", protectedRoute, getOfflineQueue);

export default mediaDeliveryRouter;

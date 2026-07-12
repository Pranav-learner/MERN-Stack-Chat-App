/**
 * @module routes/mediaRoute
 *
 * Secure Media Platform API routes (Layer 11, Sprint 1), mounted at `/api/media`. Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user is the acting
 * caller/owner.
 *
 * The server is a BLIND relay: the client encrypts media device-side and uploads OPAQUE ciphertext +
 * non-secret iv/tag + a key fingerprint. The pipeline stores the blob via a PLUGGABLE storage provider,
 * verifies integrity, and serves opaque ciphertext for device-side decryption. Whole-payload this sprint
 * (streaming is Sprint 2). Static / collection paths precede the `:mediaId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  uploadMedia,
  downloadMedia,
  deleteMedia,
  cancelUpload,
  cancelDownload,
  retryUpload,
  retryDownload,
  getMetadata,
  listMedia,
  verifyMedia,
  getOperation,
  getOperations,
  getDiagnostics,
  health,
} from "../controllers/mediaController.js";

const mediaRouter = express.Router();

// --- observability + collection --------------------------------------------
mediaRouter.get("/health", protectedRoute, health);
mediaRouter.post("/", protectedRoute, uploadMedia);
mediaRouter.get("/", protectedRoute, listMedia);

// --- operations (static prefixes before :mediaId) ---------------------------
mediaRouter.get("/operations/:operationId", protectedRoute, getOperation);
mediaRouter.post("/uploads/:operationId/cancel", protectedRoute, cancelUpload);
mediaRouter.post("/uploads/:operationId/retry", protectedRoute, retryUpload);
mediaRouter.post("/downloads/:operationId/cancel", protectedRoute, cancelDownload);
mediaRouter.post("/downloads/:operationId/retry", protectedRoute, retryDownload);

// --- per-media --------------------------------------------------------------
mediaRouter.get("/:mediaId", protectedRoute, getMetadata);
mediaRouter.get("/:mediaId/download", protectedRoute, downloadMedia);
mediaRouter.delete("/:mediaId", protectedRoute, deleteMedia);
mediaRouter.get("/:mediaId/verify", protectedRoute, verifyMedia);
mediaRouter.get("/:mediaId/operations", protectedRoute, getOperations);
mediaRouter.get("/:mediaId/diagnostics", protectedRoute, getDiagnostics);

export default mediaRouter;

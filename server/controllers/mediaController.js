/**
 * @module controllers/mediaController
 *
 * HTTP handlers for the **Secure Media Platform** (Layer 11, Sprint 1), mounted at `/api/media`. It
 * securely handles ENCRYPTED media through its whole lifecycle: upload, download, delete, cancel, retry,
 * metadata, integrity verification, operation status, and pipeline diagnostics.
 *
 * The server is a BLIND relay: the client encrypts the media DEVICE-SIDE (per-file media key, never
 * sent) and uploads OPAQUE ciphertext (base64 over JSON) + non-secret `{ iv, authTag }` + a key
 * fingerprint + the plaintext hash. The server stores the ciphertext blob (via a pluggable storage
 * provider) + metadata, verifies integrity, and serves the opaque ciphertext back for device-side
 * decryption. Every route is JWT-protected; `req.user._id` is the acting caller/owner.
 *
 * @note The default storage provider is the FILESYSTEM provider (pluggable) — swap in an S3-compatible
 * or decentralized provider without changing this controller. Whole-payload this sprint (JSON body
 * limit applies); Sprint 2 adds streaming/progressive transfers.
 */

import path from "node:path";
import os from "node:os";
import { MediaManager } from "../media/manager/mediaManager.js";
import { createMediaApi } from "../media/api/mediaApi.js";
import { createMongoMediaRepository } from "../media/repository/mongoMediaRepository.js";
import { createFilesystemStorageProvider } from "../media/providers/filesystemStorageProvider.js";
import { MediaEventBus } from "../media/events/events.js";
import { MediaError } from "../media/errors.js";

/** Shared media event bus. A future Sprint 2 (streaming / previews) subscribes here. */
export const mediaEvents = new MediaEventBus();

/** The storage provider — filesystem by default (pluggable via MEDIA_STORAGE_DIR). */
const storageProvider = createFilesystemStorageProvider({ baseDir: process.env.MEDIA_STORAGE_DIR || path.join(os.tmpdir(), "secure-media-store") });

/** Process-wide Media Manager over the Mongo-backed metadata repository + the pluggable storage provider. */
export const mediaManager = new MediaManager({ ...createMongoMediaRepository(), storageProvider, events: mediaEvents });

/** The stable facade the HTTP handlers delegate to. */
export const mediaApi = createMediaApi(mediaManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof MediaError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

// === lifecycle ==============================================================

/** POST /media — upload encrypted media. Body: { filename, contentType, ciphertext(base64), plaintextHash, encryption:{keyFingerprint,iv,authTag}, conversationId?, groupId? }. */
export const uploadMedia = async (req, res) => {
  try {
    const result = await mediaApi.uploadMedia({ ownerId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "uploadMedia");
  }
};

/** GET /media/:mediaId/download — download encrypted media (opaque ciphertext + iv/tag). */
export const downloadMedia = async (req, res) => {
  try {
    const download = await mediaApi.downloadMedia({ mediaId: req.params.mediaId, actorId: callerId(req) });
    return res.status(200).json({ success: true, download });
  } catch (error) {
    return handleError(res, error, "downloadMedia");
  }
};

/** DELETE /media/:mediaId — soft-delete media (owner only). */
export const deleteMedia = async (req, res) => {
  try {
    const media = await mediaApi.deleteMedia({ mediaId: req.params.mediaId, actorId: callerId(req) });
    return res.status(200).json({ success: true, media });
  } catch (error) {
    return handleError(res, error, "deleteMedia");
  }
};

// === cancel + retry =========================================================

/** POST /media/uploads/:operationId/cancel — cancel an in-flight upload. */
export const cancelUpload = async (req, res) => {
  try {
    const operation = await mediaApi.cancelUpload({ operationId: req.params.operationId, actorId: callerId(req) });
    return res.status(200).json({ success: true, operation });
  } catch (error) {
    return handleError(res, error, "cancelUpload");
  }
};

/** POST /media/downloads/:operationId/cancel — cancel an in-flight download. */
export const cancelDownload = async (req, res) => {
  try {
    const operation = await mediaApi.cancelDownload({ operationId: req.params.operationId, actorId: callerId(req) });
    return res.status(200).json({ success: true, operation });
  } catch (error) {
    return handleError(res, error, "cancelDownload");
  }
};

/** POST /media/uploads/:operationId/retry — retry a failed upload. Body: { ciphertext(base64) }. */
export const retryUpload = async (req, res) => {
  try {
    const result = await mediaApi.retryUpload({ operationId: req.params.operationId, ciphertext: req.body?.ciphertext, actorId: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "retryUpload");
  }
};

/** POST /media/downloads/:operationId/retry — retry a failed download. */
export const retryDownload = async (req, res) => {
  try {
    const download = await mediaApi.retryDownload({ operationId: req.params.operationId, actorId: callerId(req) });
    return res.status(200).json({ success: true, download });
  } catch (error) {
    return handleError(res, error, "retryDownload");
  }
};

// === reads + integrity + diagnostics ========================================

/** GET /media/:mediaId — media metadata (no blob). */
export const getMetadata = async (req, res) => {
  try {
    const media = await mediaApi.getMetadata({ mediaId: req.params.mediaId, actorId: callerId(req) });
    return res.status(200).json({ success: true, media });
  } catch (error) {
    return handleError(res, error, "getMetadata");
  }
};

/** GET /media — list the caller's media (?state=&limit=). */
export const listMedia = async (req, res) => {
  try {
    const media = await mediaApi.listMedia({ ownerId: callerId(req), state: req.query.state, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, media });
  } catch (error) {
    return handleError(res, error, "listMedia");
  }
};

/** GET /media/:mediaId/verify — re-verify integrity on demand (tamper detection). */
export const verifyMedia = async (req, res) => {
  try {
    const integrity = await mediaApi.verifyMedia({ mediaId: req.params.mediaId, actorId: callerId(req) });
    return res.status(200).json({ success: true, integrity });
  } catch (error) {
    return handleError(res, error, "verifyMedia");
  }
};

/** GET /media/operations/:operationId — an operation's status. */
export const getOperation = async (req, res) => {
  try {
    const operation = await mediaApi.getOperation({ operationId: req.params.operationId });
    return res.status(200).json({ success: true, operation });
  } catch (error) {
    return handleError(res, error, "getOperation");
  }
};

/** GET /media/:mediaId/operations — operation history (?type=upload|download). */
export const getOperations = async (req, res) => {
  try {
    const operations = await mediaApi.getOperations({ mediaId: req.params.mediaId, type: req.query.type });
    return res.status(200).json({ success: true, operations });
  } catch (error) {
    return handleError(res, error, "getOperations");
  }
};

/** GET /media/:mediaId/diagnostics — pipeline diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await mediaApi.getDiagnostics({ mediaId: req.params.mediaId });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /media-health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await mediaApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

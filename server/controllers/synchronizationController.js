/**
 * @module controllers/synchronizationController
 *
 * HTTP handlers for the **Offline Synchronization Engine** (Layer 9, Sprint 1), mounted at
 * `/api/synchronization`. Devices register their replica (version maps), ask "what am I missing?"
 * (delta), start/pause/resume/cancel synchronization sessions, pull operations to apply, and report
 * progress. The server computes deltas + deterministic plans + tracks resumable sessions.
 *
 * This engine determines WHAT state is missing + HOW to sync it — it does NOT move bytes (the Layer-8
 * Data Plane transports the already-encrypted content) and does NOT do conflict resolution / merge /
 * consensus / group sync (Sprint 2). Every route is JWT-protected; `req.user._id` is the acting device.
 *
 * @security Reasons over VERSION METADATA + entity IDs only — never plaintext, ciphertext, or keys.
 * Sessions + replicas are owner-scoped.
 */

import { SynchronizationManager } from "../synchronization/manager/synchronizationManager.js";
import { createSyncApi } from "../synchronization/api/syncApi.js";
import { createMongoSyncRepository } from "../synchronization/repository/mongoSyncRepository.js";
import { SyncEventBus } from "../synchronization/events/events.js";
import { SyncError } from "../synchronization/errors.js";

/** Shared synchronization event bus. A future Sprint 2 (replication / conflict resolution) subscribes here. */
export const syncEvents = new SyncEventBus();

/** Process-wide Synchronization Manager over the Mongo-backed repository. */
export const synchronizationManager = new SynchronizationManager({ ...createMongoSyncRepository(), events: syncEvents });

/** The stable facade the HTTP handlers delegate to. */
export const syncApi = createSyncApi(synchronizationManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof SyncError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/synchronization/replicas — register/update this device's replica. Body: { categoryVersions, metadata? }. */
export const registerReplica = async (req, res) => {
  try {
    const replica = await syncApi.registerReplica({ deviceId: callerId(req), userId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "registerReplica");
  }
};

/** GET /api/synchronization/replicas/me — this device's replica. */
export const getReplica = async (req, res) => {
  try {
    const replica = await syncApi.getReplica({ deviceId: callerId(req) });
    return res.status(200).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "getReplica");
  }
};

/** POST /api/synchronization/delta — compute what this device is missing. Body: { sourceReplicaId?/sourceDeviceId, categories?, since?, includeRefs? }. */
export const computeMissingState = async (req, res) => {
  try {
    const delta = await syncApi.computeMissingState({ targetDeviceId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, delta });
  } catch (error) {
    return handleError(res, error, "computeMissingState");
  }
};

/** POST /api/synchronization/sessions — start a synchronization session. Body: { sourceReplicaId?/sourceDeviceId, categories?, since?, batchSize? }. */
export const startSync = async (req, res) => {
  try {
    const result = await syncApi.startSync({ targetDeviceId: callerId(req), actingDevice: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "startSync");
  }
};

/** GET /api/synchronization/sessions/:sessionId/operations — pull the next operations to apply (?max=). */
export const getNextOperations = async (req, res) => {
  try {
    const operations = await syncApi.getNextOperations({ sessionId: req.params.sessionId, actingDevice: callerId(req), max: req.query.max ? Number(req.query.max) : undefined });
    return res.status(200).json({ success: true, operations });
  } catch (error) {
    return handleError(res, error, "getNextOperations");
  }
};

/** POST /api/synchronization/sessions/:sessionId/progress — report applied/failed operations. Body: { appliedOpIds, failedOpIds? }. */
export const recordProgress = async (req, res) => {
  try {
    const status = await syncApi.recordProgress({ sessionId: req.params.sessionId, actingDevice: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "recordProgress");
  }
};

/** POST /api/synchronization/sessions/:sessionId/pause — pause a session. */
export const pauseSync = async (req, res) => {
  try {
    const session = await syncApi.pauseSync({ sessionId: req.params.sessionId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "pauseSync");
  }
};

/** POST /api/synchronization/sessions/:sessionId/resume — resume a paused session. */
export const resumeSync = async (req, res) => {
  try {
    const session = await syncApi.resumeSync({ sessionId: req.params.sessionId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "resumeSync");
  }
};

/** POST /api/synchronization/sessions/:sessionId/cancel — cancel a session. */
export const cancelSync = async (req, res) => {
  try {
    const session = await syncApi.cancelSync({ sessionId: req.params.sessionId, actingDevice: callerId(req), reason: req.body?.reason });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "cancelSync");
  }
};

/** GET /api/synchronization/sessions/:sessionId — a session. */
export const getSession = async (req, res) => {
  try {
    const session = await syncApi.getSession({ sessionId: req.params.sessionId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, session });
  } catch (error) {
    return handleError(res, error, "getSession");
  }
};

/** GET /api/synchronization/sessions/:sessionId/status — a session's status. */
export const getStatus = async (req, res) => {
  try {
    const status = await syncApi.getStatus({ sessionId: req.params.sessionId });
    return res.status(200).json({ success: true, status });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/synchronization/sessions/:sessionId/diagnostics — full diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await syncApi.getDiagnostics({ sessionId: req.params.sessionId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/synchronization/sessions — the caller's active sessions. */
export const listSessions = async (req, res) => {
  try {
    const sessions = await syncApi.listSessions({ deviceId: callerId(req) });
    return res.status(200).json({ success: true, sessions });
  } catch (error) {
    return handleError(res, error, "listSessions");
  }
};

/** GET /api/synchronization/health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await syncApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

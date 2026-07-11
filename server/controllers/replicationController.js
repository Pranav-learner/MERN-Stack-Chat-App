/**
 * @module controllers/replicationController
 *
 * HTTP handlers for the **State Replication & Conflict Resolution** subsystem (Layer 9, Sprint 2),
 * mounted at `/api/replication`. Every authenticated device is a secure encrypted REPLICA: it
 * registers its version records, compares itself against another replica, synchronizes (resolving
 * conflicts + merging deterministically), replicates deltas, resumes interrupted synchronization, and
 * reads version/conflict history + diagnostics.
 *
 * This subsystem reasons over VERSION METADATA + entity IDs + non-secret merge metadata ONLY — never
 * plaintext, ciphertext, or keys (the encrypted content is transported by Layer 8). Every route is
 * JWT-protected; `req.user._id` is the acting device. Replicas + sessions are owner-scoped.
 *
 * @note The server acts as an authoritative replica coordinator; a deployment can set the
 * authoritative replica for the server-authority policy. It does NOT decrypt content.
 */

import { ReplicaManager } from "../replication/manager/replicaManager.js";
import { createReplicationApi } from "../replication/api/replicationApi.js";
import { createMongoReplicationRepository } from "../replication/repository/mongoReplicationRepository.js";
import { ReplicationEventBus } from "../replication/events/events.js";
import { ReplicationError } from "../replication/errors.js";

/** Shared replication event bus. A future Layer 10 subscribes here. */
export const replicationEvents = new ReplicationEventBus();

/** Process-wide Replica Manager over the Mongo-backed repository. */
export const replicaManager = new ReplicaManager({ ...createMongoReplicationRepository(), events: replicationEvents });

/** The stable facade the HTTP handlers delegate to. */
export const replicationApi = createReplicationApi(replicaManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof ReplicationError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/replication/replicas — register/update this device's replica. Body: { categories, metadata? }. */
export const registerReplica = async (req, res) => {
  try {
    const replica = await replicationApi.registerReplica({ deviceId: callerId(req), userId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "registerReplica");
  }
};

/** GET /api/replication/replicas/me — this device's replica status. */
export const getReplicaStatus = async (req, res) => {
  try {
    const replica = await replicationApi.getReplicaStatus({ deviceId: callerId(req), actingDevice: callerId(req) });
    return res.status(200).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "getReplicaStatus");
  }
};

/** POST /api/replication/compare — compare this device's replica against a source. Body: { sourceReplicaId?/sourceDeviceId, categories? }. */
export const compareReplicas = async (req, res) => {
  try {
    const comparison = await replicationApi.compareReplicas({ targetDeviceId: callerId(req), ...(req.body ?? {}) }, { actingDevice: callerId(req) });
    return res.status(200).json({ success: true, comparison });
  } catch (error) {
    return handleError(res, error, "compareReplicas");
  }
};

/** POST /api/replication/synchronize — synchronize (resolve + merge). Body: { sourceReplicaId?/sourceDeviceId, categories?, policy?, authorityReplicaId? }. */
export const synchronizeReplicas = async (req, res) => {
  try {
    const result = await replicationApi.synchronizeReplicas({ targetDeviceId: callerId(req), ...(req.body ?? {}) }, { actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "synchronizeReplicas");
  }
};

/** POST /api/replication/merge — merge a source replica into this device (alias of synchronize). */
export const mergeReplica = async (req, res) => {
  try {
    const result = await replicationApi.mergeReplica({ targetDeviceId: callerId(req), ...(req.body ?? {}) }, { actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "mergeReplica");
  }
};

/** POST /api/replication/resolve — resolve a single conflict. Body: { sourceReplicaId/Device, category, entityId, policy? }. */
export const resolveConflict = async (req, res) => {
  try {
    const resolution = await replicationApi.resolveConflict({ targetDeviceId: callerId(req), ...(req.body ?? {}) }, { actingDevice: callerId(req) });
    return res.status(200).json({ success: true, resolution });
  } catch (error) {
    return handleError(res, error, "resolveConflict");
  }
};

/** POST /api/replication/delta — replicate an incremental delta (catch-up). Body: { sourceReplicaId?/sourceDeviceId, categories?, maxItems? }. */
export const replicateDelta = async (req, res) => {
  try {
    const result = await replicationApi.replicateDelta({ targetDeviceId: callerId(req), ...(req.body ?? {}) }, { actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "replicateDelta");
  }
};

/** POST /api/replication/resume — resume an interrupted synchronization. Body: { sourceReplicaId?/sourceDeviceId, cursor, categories? }. */
export const resumeSynchronization = async (req, res) => {
  try {
    const result = await replicationApi.resumeSynchronization({ targetDeviceId: callerId(req), ...(req.body ?? {}) }, { actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resumeSynchronization");
  }
};

/** GET /api/replication/replicas/:replicaId/version-history — version history (?category=&entityId=&limit=). */
export const getVersionHistory = async (req, res) => {
  try {
    const history = await replicationApi.getVersionHistory({ replicaId: req.params.replicaId, category: req.query.category, entityId: req.query.entityId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getVersionHistory");
  }
};

/** GET /api/replication/replicas/:replicaId/conflict-history — conflict history (?limit=). */
export const getConflictHistory = async (req, res) => {
  try {
    const history = await replicationApi.getConflictHistory({ replicaId: req.params.replicaId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, history });
  } catch (error) {
    return handleError(res, error, "getConflictHistory");
  }
};

/** GET /api/replication/replicas/:replicaId/diagnostics — full replica diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await replicationApi.getDiagnostics({ replicaId: req.params.replicaId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/replication/health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await replicationApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

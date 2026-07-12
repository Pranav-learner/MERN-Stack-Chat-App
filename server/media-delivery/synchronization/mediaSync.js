/**
 * @module media-delivery/synchronization
 *
 * **Media synchronization** — keeps a device's MEDIA AVAILABILITY in sync across a user's devices,
 * reusing the Layer 9 delta model at media scope: a per-device availability replica (which media are
 * fully downloaded locally) is compared against the AUTHORITATIVE set (the media the device should have,
 * e.g. from its conversations/groups) to compute what is MISSING, producing a deterministic, resumable
 * sync plan + an OFFLINE MEDIA QUEUE for media to fetch when the device reconnects.
 *
 * @security A replica / delta / plan carries media IDS + availability states + versions ONLY — never
 * ciphertext or keys. Pure functions, no I/O — the engine owns persistence + the offline queue.
 *
 * @evolution Integrates with Layer 9: the availability replica is a media-scoped `entityId → version`
 * map, so a future group/offline sync can drive it off the existing synchronization engine.
 */

import crypto from "node:crypto";
import { MediaAvailability, TransferPriority, MEDIA_DELIVERY_SCHEMA_VERSION } from "../types/types.js";

/**
 * Build a per-device media-availability replica. @param {object} params
 * @param {string} params.deviceId @param {string[]} [params.available] media ids fully downloaded locally
 * @param {() => number} [params.clock]
 */
export function buildAvailabilityReplica(params) {
  const clock = params.clock ?? (() => Date.now());
  const nowIso = new Date(clock()).toISOString();
  const available = [...new Set((params.available ?? []).map(String))];
  return {
    deviceId: String(params.deviceId),
    userId: String(params.userId ?? params.deviceId),
    available, // media ids present on the device
    availableCount: available.length,
    version: params.version ?? 1,
    fingerprint: fingerprint(available),
    updatedAt: nowIso,
    schemaVersion: MEDIA_DELIVERY_SCHEMA_VERSION,
  };
}

function fingerprint(available) {
  return crypto.createHash("sha256").update([...available].sort().join(",")).digest("hex").slice(0, 32);
}

/**
 * Compute the media delta a device is missing vs. the authoritative set. Pure. @param {object} replica
 * @param {string[]} authoritativeMediaIds media the device SHOULD have
 * @returns {{ missing: string[], available: string[], stale: string[], upToDate: boolean }}
 */
export function computeMediaDelta(replica, authoritativeMediaIds = []) {
  const have = new Set((replica?.available ?? []).map(String));
  const want = [...new Set(authoritativeMediaIds.map(String))];
  const missing = want.filter((m) => !have.has(m));
  const available = want.filter((m) => have.has(m));
  const stale = [...have].filter((m) => !want.includes(m)); // present locally but no longer authoritative
  return { missing, available, stale, upToDate: missing.length === 0 };
}

/**
 * Build a deterministic, resumable media sync plan for a device. Missing media become fetch operations
 * (deduped, priority-ordered). Pure. @param {object} params
 * @param {string} params.deviceId @param {object} params.delta @param {(mediaId) => string} [params.priorityOf]
 * @param {() => string} [params.idGenerator]
 */
export function createMediaSyncPlan(params) {
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const priorityOf = params.priorityOf ?? (() => TransferPriority.NORMAL);
  const missing = [...new Set((params.delta?.missing ?? []).map(String))];
  const operations = missing.map((mediaId, i) => ({ index: i, mediaId, action: "fetch", priority: priorityOf(mediaId), availability: MediaAvailability.PENDING }));
  return {
    planId: idGenerator(),
    deviceId: String(params.deviceId),
    operations,
    total: operations.length,
    cursor: 0,
    upToDate: operations.length === 0,
    planHash: crypto.createHash("sha256").update(missing.join("|")).digest("hex").slice(0, 32),
  };
}

/** The operations remaining after a resume cursor (partial sync). */
export function remainingSyncOps(plan, cursor = 0) {
  return (plan.operations ?? []).slice(Math.max(0, cursor));
}

/** Mark a media id available in a replica (monotonic add). Returns a NEW replica. */
export function markAvailable(replica, mediaId, at = new Date().toISOString()) {
  const available = new Set((replica?.available ?? []).map(String));
  if (available.has(String(mediaId))) return replica;
  available.add(String(mediaId));
  const arr = [...available];
  return { ...replica, available: arr, availableCount: arr.length, version: (replica.version ?? 1) + 1, fingerprint: fingerprint(arr), updatedAt: at };
}

export { MediaAvailability };

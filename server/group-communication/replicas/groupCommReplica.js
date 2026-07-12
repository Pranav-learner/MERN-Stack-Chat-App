/**
 * @module group-communication/replicas
 *
 * The **Group Communication Replica** — EXTENDS the Sprint-1 group replica snapshot (membership +
 * metadata + version vector) with the COMMUNICATION facets a device needs to participate: the active
 * key version, the delivery cursor (last message it has), and any pending updates it still owes. Each
 * device that belongs to a group keeps one; the engine reconciles them via group synchronization.
 *
 * A comm-replica holds:
 *  - `facetVersions` — `{ membership, metadata, keyVersion, replica }` monotonic counters (sync deltas)
 *  - `keyVersion`    — the highest group-key epoch this device has
 *  - `deliveryCursor`— the last group message id + timestamp this device has received
 *  - `pendingUpdates`— queued facet updates not yet applied (offline edits / missed rekeys)
 *  - `recovery`      — metadata for resuming an interrupted sync
 *  - `diagnostics`   — counts + a drift indicator
 *  - `fingerprint`   — an opaque digest for cheap divergence detection
 *
 * @security Holds ids + versions + counts + fingerprints ONLY — never ciphertext or keys.
 *
 * @evolution `facetVersions` is the seam that maps onto Layer 9's `entityId → version` sync maps.
 * Pure functions, no I/O.
 */

import crypto from "node:crypto";
import { GROUP_COMM_SCHEMA_VERSION, GroupSyncFacet, ALL_GROUP_SYNC_FACETS } from "../types/types.js";
import { ReplicaMismatchError } from "../errors.js";

/** Deterministic JSON (sorted keys) so fingerprints are stable across runs + devices. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Normalize a facet-version map (defaults each facet to 0). */
export function normalizeFacetVersions(facets = {}) {
  const out = {};
  for (const f of ALL_GROUP_SYNC_FACETS) out[f] = Number.isFinite(facets[f]) && facets[f] >= 0 ? Math.floor(facets[f]) : 0;
  return out;
}

/** An opaque replica fingerprint over the material comm state. */
export function commReplicaFingerprint(facetVersions, keyVersion, deliveryCursor) {
  const material = { f: normalizeFacetVersions(facetVersions), k: keyVersion ?? 0, c: deliveryCursor?.messageId ?? null };
  return crypto.createHash("sha256").update(stableStringify(material)).digest("hex");
}

/**
 * Build a group-communication replica. @param {object} params
 * @param {string} params.groupId @param {string} params.deviceId @param {string} [params.memberId]
 * @param {object} [params.facetVersions] @param {number} [params.keyVersion] @param {object} [params.deliveryCursor]
 * @param {object[]} [params.pendingUpdates] @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 */
export function buildCommReplica(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const facetVersions = normalizeFacetVersions(params.facetVersions);
  const keyVersion = params.keyVersion ?? 0;
  const deliveryCursor = params.deliveryCursor ?? { messageId: null, at: null };
  const pendingUpdates = params.pendingUpdates ?? [];
  return {
    replicaId: params.replicaId ?? idGenerator(),
    groupId: String(params.groupId),
    deviceId: String(params.deviceId),
    memberId: String(params.memberId ?? params.deviceId),
    facetVersions,
    keyVersion,
    deliveryCursor,
    pendingUpdates,
    recovery: { lastSyncAt: null, lastSyncedFacets: { ...facetVersions }, interrupted: false },
    diagnostics: { pendingUpdates: pendingUpdates.length, drift: 0 },
    fingerprint: commReplicaFingerprint(facetVersions, keyVersion, deliveryCursor),
    createdAt: nowIso,
    updatedAt: nowIso,
    schemaVersion: GROUP_COMM_SCHEMA_VERSION,
  };
}

/**
 * Compute the per-facet delta a device is MISSING relative to the group's authoritative facet versions.
 * This is the group-sync analogue of Layer 9's delta detection. Pure.
 * @param {object} replica the device's comm replica @param {object} authoritative `{ membership, metadata, keyVersion, replica }`
 * @returns {{ facets: object, missing: string[], upToDate: boolean }}
 */
export function computeReplicaDelta(replica, authoritative) {
  const have = normalizeFacetVersions(replica?.facetVersions);
  const want = normalizeFacetVersions(authoritative);
  const facets = {};
  const missing = [];
  for (const f of ALL_GROUP_SYNC_FACETS) {
    if (want[f] > have[f]) {
      facets[f] = { from: have[f], to: want[f] };
      missing.push(f);
    }
  }
  return { facets, missing, upToDate: missing.length === 0 };
}

/**
 * Apply an authoritative facet-version set to a replica (monotonic — never regresses). Returns a NEW
 * replica + which facets advanced. @throws {ReplicaMismatchError} if the authoritative set is behind.
 */
export function applyReplicaUpdate(replica, authoritative, { keyVersion, deliveryCursor, at } = {}) {
  const have = normalizeFacetVersions(replica.facetVersions);
  const want = normalizeFacetVersions(authoritative);
  const advanced = [];
  const next = { ...have };
  for (const f of ALL_GROUP_SYNC_FACETS) {
    if (want[f] < have[f]) throw new ReplicaMismatchError(`Authoritative ${f} version (${want[f]}) is behind the replica (${have[f]})`, { details: { facet: f } });
    if (want[f] > have[f]) {
      next[f] = want[f];
      advanced.push(f);
    }
  }
  const nextKeyVersion = Math.max(replica.keyVersion ?? 0, keyVersion ?? 0);
  const cursor = deliveryCursor ?? replica.deliveryCursor;
  const nowIso = at ?? new Date().toISOString();
  return {
    replica: {
      ...replica,
      facetVersions: next,
      keyVersion: nextKeyVersion,
      deliveryCursor: cursor,
      recovery: { lastSyncAt: nowIso, lastSyncedFacets: { ...next }, interrupted: false },
      diagnostics: { ...replica.diagnostics, pendingUpdates: (replica.pendingUpdates ?? []).length },
      fingerprint: commReplicaFingerprint(next, nextKeyVersion, cursor),
      updatedAt: nowIso,
    },
    advanced,
  };
}

/** Validate a comm-replica's shape. @throws {ReplicaMismatchError} */
export function validateCommReplica(replica) {
  if (!replica || typeof replica !== "object") throw new ReplicaMismatchError("replica must be an object");
  if (!replica.groupId || !replica.deviceId) throw new ReplicaMismatchError("replica is missing groupId/deviceId");
  return replica;
}

export { GroupSyncFacet };

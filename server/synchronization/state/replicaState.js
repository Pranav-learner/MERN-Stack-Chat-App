/**
 * @module synchronization/state
 *
 * The **Replica State** model — a device's synchronization view expressed as per-category VERSION MAPS.
 * A replica records, for each syncable category, the version of every entity it holds (`entityId →
 * version`) plus a category high-water version, an overall monotonic `syncVersion`, and its last
 * successful sync. This is the ground truth the {@link module:synchronization/delta delta detector}
 * diffs to decide *what a target device is missing*.
 *
 * @security A replica holds VERSION METADATA + entity IDs ONLY — never plaintext, ciphertext, or keys.
 * Version numbers are logical clocks (monotonic counters), not timestamps of content.
 *
 * @distributed Version maps are the classic building block of state-based synchronization: comparing
 * two replicas' maps yields the diff without moving any data. Sprint 1 does DIRECTIONAL sync (compute
 * what a target lacks vs. a source); Sprint 2 layers merge/conflict policies on the same maps.
 */

import crypto from "node:crypto";
import { ALL_SYNC_CATEGORIES, SYNC_SCHEMA_VERSION } from "../types/types.js";

/** The high-water version of a category (max entity version; 0 when empty). */
export function categoryHighWater(entities) {
  let max = 0;
  for (const v of Object.values(entities ?? {})) if (v > max) max = v;
  return max;
}

/** Normalize an input category-versions object into `{ [category]: { version, entities } }`. */
export function normalizeCategoryVersions(input = {}) {
  const out = {};
  for (const category of ALL_SYNC_CATEGORIES) {
    const raw = input[category];
    const entities = raw?.entities ?? (raw && typeof raw === "object" && !("version" in raw) ? raw : {});
    const clean = {};
    for (const [id, v] of Object.entries(entities ?? {})) {
      if (Number.isFinite(v) && v >= 0) clean[String(id)] = v;
    }
    out[category] = { version: raw?.version != null ? Math.max(raw.version, categoryHighWater(clean)) : categoryHighWater(clean), entities: clean };
  }
  return out;
}

/**
 * Build a replica state record.
 * @param {object} params `{ replicaId?, deviceId, userId, categoryVersions?, metadata?, clock?, idGenerator? }`
 * @returns {import("../types/types.js").ReplicaState}
 */
export function createReplica(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const categoryVersions = normalizeCategoryVersions(params.categoryVersions);
  return {
    replicaId: params.replicaId ?? idGenerator(),
    deviceId: String(params.deviceId),
    userId: String(params.userId ?? params.deviceId),
    categoryVersions,
    syncVersion: params.syncVersion ?? 1,
    lastSuccessfulSync: params.lastSuccessfulSync ?? null,
    pendingChanges: params.pendingChanges ?? totalEntities(categoryVersions),
    metadata: params.metadata ?? {},
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 1,
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
}

/** Total entity count across all categories. */
export function totalEntities(categoryVersions) {
  let n = 0;
  for (const category of ALL_SYNC_CATEGORIES) n += Object.keys(categoryVersions?.[category]?.entities ?? {}).length;
  return n;
}

/**
 * Monotonically apply learned entity versions to a replica's category (never regresses). Pure — returns
 * a NEW category-versions object. Used when a target replica finishes applying synced entities: its map
 * advances to include them at the source's versions.
 * @param {object} categoryVersions @param {string} category @param {Array<{ entityId: string, version: number }>} entityVersions
 * @returns {object} new categoryVersions
 */
export function applyEntityVersions(categoryVersions, category, entityVersions) {
  const next = structuredClone(categoryVersions ?? {});
  const cat = next[category] ?? { version: 0, entities: {} };
  const entities = { ...cat.entities };
  for (const { entityId, version } of entityVersions ?? []) {
    const id = String(entityId);
    if (!Number.isFinite(version)) continue;
    if (entities[id] === undefined || entities[id] < version) entities[id] = version;
  }
  next[category] = { version: Math.max(cat.version ?? 0, categoryHighWater(entities)), entities };
  return next;
}

/** A compact per-category summary of a replica (counts + high-water versions) — safe for DTOs. */
export function replicaSummary(replica) {
  const categories = {};
  for (const category of ALL_SYNC_CATEGORIES) {
    const cat = replica.categoryVersions?.[category] ?? { version: 0, entities: {} };
    categories[category] = { version: cat.version, count: Object.keys(cat.entities).length };
  }
  return { replicaId: replica.replicaId, deviceId: replica.deviceId, syncVersion: replica.syncVersion, lastSuccessfulSync: replica.lastSuccessfulSync, categories };
}

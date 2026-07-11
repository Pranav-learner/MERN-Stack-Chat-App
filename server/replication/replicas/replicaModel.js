/**
 * @module replication/replicas
 *
 * The **Replica** model for Sprint 2 — a device's full replica state as per-category maps of rich
 * VERSION RECORDS (`entityId → EntityVersion`). This EXTENDS the Sprint 1 replica (a plain `entityId →
 * number`): each record now also carries its writer, timestamp, opaque content hash, tombstone, and
 * mergeable metadata, so the replica can detect conflicts + merge concurrent edits.
 *
 * @security Records hold versions + ids + non-secret merge metadata ONLY — never plaintext, ciphertext,
 * or keys. `contentHash` is an opaque divergence detector.
 *
 * Pure helpers — no I/O. All mutations return NEW snapshots (immutable), which keeps merges + conflict
 * resolution deterministic + side-effect free.
 */

import crypto from "node:crypto";
import { ALL_CATEGORIES, REPLICATION_SCHEMA_VERSION } from "../types/types.js";
import { compareStamps } from "../versions/versionStamp.js";
import { StampOrder } from "../types/types.js";

/** Normalize + clean an incoming category map into `{ [category]: { entityId: EntityVersion } }`. */
export function normalizeCategories(input = {}) {
  const out = {};
  for (const category of ALL_CATEGORIES) {
    const raw = input[category] ?? {};
    const clean = {};
    for (const [entityId, rec] of Object.entries(raw)) {
      clean[String(entityId)] = normalizeRecord(entityId, rec);
    }
    out[category] = clean;
  }
  return out;
}

/** Normalize a single entity version record (accepts a bare number for Sprint-1 compatibility). */
export function normalizeRecord(entityId, rec) {
  if (typeof rec === "number") return { entityId: String(entityId), version: rec, writerReplicaId: "unknown", updatedAt: new Date(0).toISOString(), contentHash: `v${rec}` };
  return {
    entityId: String(entityId),
    version: Number.isFinite(rec?.version) ? rec.version : 0,
    writerReplicaId: String(rec?.writerReplicaId ?? "unknown"),
    updatedAt: rec?.updatedAt ?? new Date(0).toISOString(),
    contentHash: rec?.contentHash ?? `v${rec?.version ?? 0}`,
    ...(rec?.deleted !== undefined ? { deleted: !!rec.deleted } : {}),
    ...(rec?.meta !== undefined ? { meta: rec.meta } : {}),
  };
}

/**
 * Build a replica snapshot.
 * @param {{ replicaId?, deviceId, userId?, categories?, metadata?, replicaVersion?, clock?, idGenerator? }} params
 * @returns {import("../types/types.js").ReplicaSnapshot}
 */
export function createReplicaSnapshot(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  return {
    replicaId: params.replicaId ?? idGenerator(),
    deviceId: String(params.deviceId),
    userId: String(params.userId ?? params.deviceId),
    categories: normalizeCategories(params.categories),
    replicaVersion: params.replicaVersion ?? 1,
    metadata: params.metadata ?? {},
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 1,
    schemaVersion: REPLICATION_SCHEMA_VERSION,
  };
}

/** A single entity record (or null). */
export function getRecord(snapshot, category, entityId) {
  return snapshot.categories?.[category]?.[String(entityId)] ?? null;
}

/** Set an entity record, returning a NEW snapshot (immutable). */
export function setRecord(snapshot, category, record) {
  const categories = { ...snapshot.categories, [category]: { ...(snapshot.categories?.[category] ?? {}), [record.entityId]: record } };
  return { ...snapshot, categories, updatedAt: snapshot.updatedAt };
}

/**
 * Monotonically apply an incoming record: adopt it only if it DOMINATES (or is new). Returns a NEW
 * snapshot + whether it changed. A dominated/equal record is ignored (no regression). @returns {{ snapshot, changed }}
 */
export function applyRecord(snapshot, category, incoming) {
  const existing = getRecord(snapshot, category, incoming.entityId);
  if (!existing) return { snapshot: setRecord(snapshot, category, incoming), changed: true };
  const order = compareStamps(incoming, existing);
  if (order === StampOrder.DOMINATES) return { snapshot: setRecord(snapshot, category, incoming), changed: true };
  return { snapshot, changed: false };
}

/** Total entity records across all categories. */
export function totalEntities(snapshot) {
  let n = 0;
  for (const category of ALL_CATEGORIES) n += Object.keys(snapshot.categories?.[category] ?? {}).length;
  return n;
}

/** A compact per-category summary (counts + high-water version) — safe for DTOs. */
export function replicaSummary(snapshot) {
  const categories = {};
  for (const category of ALL_CATEGORIES) {
    const recs = Object.values(snapshot.categories?.[category] ?? {});
    let hi = 0;
    for (const r of recs) if (r.version > hi) hi = r.version;
    categories[category] = { count: recs.length, version: hi };
  }
  return { replicaId: snapshot.replicaId, deviceId: snapshot.deviceId, userId: snapshot.userId, replicaVersion: snapshot.replicaVersion, categories };
}

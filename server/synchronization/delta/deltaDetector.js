/**
 * @module synchronization/delta
 *
 * **Delta detection.** Compares a SOURCE replica's version maps against a TARGET replica's and computes
 * exactly what the target is missing or has stale — per category, as entity REFS + versions. This is
 * the "what state is missing?" answer; it moves no content. Supports incremental synchronization (only
 * entities changed past a per-category cursor) and produces deterministic delta metadata.
 *
 * @security Emits entity IDs + versions + counts ONLY — never plaintext or content. Attachment /
 * transfer entries are metadata references; the encrypted bytes are moved by Layer 8, not here.
 *
 * @performance O(total source entities) with sorted iteration for determinism. `since` prunes the scan
 * to only changed entities for incremental syncs. Delta compression is a FUTURE seam ({@link compressDelta}).
 */

import { ALL_SYNC_CATEGORIES, CATEGORY_SIZE_HINT, SyncCategory } from "../types/types.js";
import { MalformedDeltaError } from "../errors.js";

/**
 * Compute what `target` is missing relative to `source`.
 * @param {object} source a replica (or `{ categoryVersions }`) — the authoritative view
 * @param {object} target a replica (or `{ categoryVersions }`) — the device catching up
 * @param {{ categories?: string[], since?: Object<string, number>, now?: number, sourceReplicaId?: string, targetReplicaId?: string }} [options]
 * @returns {import("../types/types.js").SyncDelta}
 */
export function computeDelta(source, target, options = {}) {
  const sv = source?.categoryVersions;
  const tv = target?.categoryVersions;
  if (!sv || typeof sv !== "object") throw new MalformedDeltaError("source replica has no categoryVersions");
  if (!tv || typeof tv !== "object") throw new MalformedDeltaError("target replica has no categoryVersions");

  const categories = (options.categories ?? ALL_SYNC_CATEGORIES).filter((c) => ALL_SYNC_CATEGORIES.includes(c));
  const since = options.since ?? null;
  const result = {};
  let totalItems = 0;

  for (const category of categories) {
    const sEnt = sv[category]?.entities ?? {};
    const tEnt = tv[category]?.entities ?? {};
    const threshold = since ? since[category] ?? 0 : 0;
    const missing = [];
    // Deterministic order: sort entity ids.
    for (const entityId of Object.keys(sEnt).sort()) {
      const sVer = sEnt[entityId];
      if (threshold && sVer <= threshold) continue; // incremental: skip already-known versions
      const tVer = tEnt[entityId];
      if (tVer === undefined || tVer < sVer) missing.push({ entityId, version: sVer });
    }
    result[category] = { missing, count: missing.length };
    totalItems += missing.length;
  }

  return {
    categories: result,
    totalItems,
    metadata: {
      generatedAt: new Date(options.now ?? Date.now()).toISOString(),
      incremental: !!since,
      sourceReplicaId: options.sourceReplicaId ?? source.replicaId ?? null,
      targetReplicaId: options.targetReplicaId ?? target.replicaId ?? null,
      categories: categories.slice(),
    },
  };
}

/** Estimate the byte cost of a delta (metadata-only heuristic, for transfer estimation). */
export function estimateDeltaBytes(delta) {
  let bytes = 0;
  for (const category of Object.keys(delta.categories ?? {})) {
    bytes += (delta.categories[category].count ?? 0) * (CATEGORY_SIZE_HINT[category] ?? 512);
  }
  return bytes;
}

/** Whether a delta is empty (nothing to synchronize). */
export function isDeltaEmpty(delta) {
  return (delta?.totalItems ?? 0) === 0;
}

/** Validate a delta's shape. @throws {MalformedDeltaError} */
export function validateDelta(delta) {
  if (!delta || typeof delta !== "object" || typeof delta.categories !== "object") throw new MalformedDeltaError("delta is malformed");
  for (const [category, block] of Object.entries(delta.categories)) {
    if (!ALL_SYNC_CATEGORIES.includes(category)) throw new MalformedDeltaError(`delta references unknown category "${category}"`);
    if (!Array.isArray(block.missing)) throw new MalformedDeltaError(`delta.${category}.missing must be an array`);
    for (const ref of block.missing) {
      if (typeof ref.entityId !== "string" || !Number.isFinite(ref.version)) throw new MalformedDeltaError(`delta.${category} has a malformed entity ref`);
    }
  }
  return delta;
}

/**
 * FUTURE placeholder — delta compression (dedupe / range-encode entity refs). Inert in Sprint 1:
 * returns the delta unchanged. @returns {import("../types/types.js").SyncDelta}
 */
export function compressDelta(delta) {
  return delta;
}

export { SyncCategory };

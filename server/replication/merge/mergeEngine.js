/**
 * @module replication/merge
 *
 * The **Merge Engine** — deterministic reconciliation of two replicas into one converged state. Every
 * merge is a PURE function of its inputs: the same two replicas always merge to the exact same result
 * (same records, same versions, same hashes), which is what makes replication eventually consistent
 * regardless of who merges or in what order.
 *
 * Per-category strategies:
 * - **read receipts** — union of readers (max `readAt` per reader); receipts are monotonic, so a merge
 *   is lossless (nobody "un-reads").
 * - **delivery state** — the most-advanced state wins (`pending < sent < delivered < read`).
 * - **attachment / transfer / conversation / device metadata** — field-wise (max numbers, union sets,
 *   prefer-defined, latest scalar by `updatedAt`).
 * - **messages** — opaque encrypted content can't be field-merged, so a conflict is resolved by policy
 *   (last-write-wins / server-authority) via the injected resolver.
 *
 * @security Merges METADATA descriptors only — never plaintext. The merged `contentHash` is recomputed
 * over the merged metadata (an opaque digest).
 */

import {
  CATEGORY_MERGE_STRATEGY,
  MergeStrategy,
  DELIVERY_RANK,
  ALL_CATEGORIES,
  StampOrder,
  isMergeableCategory,
} from "../types/types.js";
import { compareStamps, mergedVersion, hashContent, stableStringify } from "../versions/versionStamp.js";
import { MergeError } from "../errors.js";

const MERGE_WRITER = "merge";

/**
 * Deterministically merge two version records for the same entity in a category. Pure.
 * @param {string} category @param {object} a @param {object} b @returns {object} the merged record
 */
export function mergeRecords(category, a, b) {
  if (!a) return b;
  if (!b) return a;
  const strategy = CATEGORY_MERGE_STRATEGY[category] ?? MergeStrategy.METADATA_FIELD_MERGE;
  // Deterministic + IDEMPOTENT version = max (NOT max+1): merging already-converged replicas is a
  // no-op, so gossip converges (re-merging the same content yields the same version + hash).
  const version = Math.max(a.version ?? 0, b.version ?? 0);
  const updatedAt = laterIso(a.updatedAt, b.updatedAt);
  const base = { entityId: a.entityId, version, writerReplicaId: MERGE_WRITER, updatedAt };

  switch (strategy) {
    case MergeStrategy.READ_RECEIPT_UNION: {
      const readers = mergeReaders(a.meta?.readers, b.meta?.readers);
      const meta = { readers };
      return { ...base, contentHash: hashContent({ readers }), meta };
    }
    case MergeStrategy.DELIVERY_MAX_STATE: {
      const sa = a.meta?.state ?? "pending";
      const sb = b.meta?.state ?? "pending";
      const state = (DELIVERY_RANK[sa] ?? 0) >= (DELIVERY_RANK[sb] ?? 0) ? sa : sb;
      const meta = { state };
      return { ...base, contentHash: hashContent(meta), meta };
    }
    case MergeStrategy.ATTACHMENT_FIELD_MERGE: {
      const meta = mergeAttachmentMeta(a.meta, b.meta, a, b);
      return { ...base, contentHash: hashContent(meta), meta };
    }
    case MergeStrategy.OPAQUE_LWW: {
      const winner = lwwWinner(a, b);
      return { ...base, writerReplicaId: winner.writerReplicaId, contentHash: winner.contentHash, ...(winner.meta !== undefined ? { meta: winner.meta } : {}), ...(winner.deleted !== undefined ? { deleted: winner.deleted } : {}) };
    }
    case MergeStrategy.METADATA_FIELD_MERGE:
    default: {
      const meta = mergeMetaFields(a.meta, b.meta, a, b);
      const deleted = !!(a.deleted && b.deleted); // a tombstone survives only if BOTH deleted
      return { ...base, contentHash: hashContent(meta ?? { v: version }), ...(meta !== undefined ? { meta } : {}), ...(deleted ? { deleted: true } : {}) };
    }
  }
}

/**
 * Merge two full replica snapshots into one converged snapshot. Deterministic. Conflicts (non-mergeable
 * concurrent divergence) are resolved through the INJECTED resolver.
 * @param {object} source @param {object} target
 * @param {{ conflictResolver: { resolve: Function }, categories?: string[], clock?: () => number }} options
 * @returns {{ merged: object, resolutions: object[], merges: object[], audit: object }}
 */
export function mergeReplicas(source, target, options = {}) {
  const resolver = options.conflictResolver;
  const categories = (options.categories ?? ALL_CATEGORIES).filter((c) => ALL_CATEGORIES.includes(c));
  const now = new Date(options.clock ? options.clock() : Date.now()).toISOString();
  const mergedCategories = {};
  const resolutions = [];
  const merges = [];
  let maxVersion = Math.max(source.replicaVersion ?? 0, target.replicaVersion ?? 0);

  for (const category of categories) {
    const sCat = source.categories?.[category] ?? {};
    const tCat = target.categories?.[category] ?? {};
    const entityIds = [...new Set([...Object.keys(sCat), ...Object.keys(tCat)])].sort();
    const out = {};
    for (const entityId of entityIds) {
      const s = sCat[entityId] ?? null;
      const t = tCat[entityId] ?? null;
      if (s && !t) {
        out[entityId] = s;
      } else if (!s && t) {
        out[entityId] = t;
      } else if (isMergeableCategory(category)) {
        const merged = mergeRecords(category, s, t);
        out[entityId] = merged;
        if (compareStamps(s, t) !== StampOrder.EQUAL) merges.push({ category, entityId });
      } else {
        const order = compareStamps(s, t);
        if (order === StampOrder.EQUAL) out[entityId] = t;
        else if (order === StampOrder.DOMINATES) out[entityId] = s;
        else if (order === StampOrder.DOMINATED) out[entityId] = t;
        else {
          // CONFLICT → resolve by policy.
          if (!resolver || typeof resolver.resolve !== "function") throw new MergeError("mergeReplicas requires a conflictResolver for non-mergeable conflicts", { details: { category, entityId } });
          const resolution = resolver.resolve({ category, entityId, source: s, target: t }, { now });
          out[entityId] = resolution.winner;
          resolutions.push({ category, entityId, policy: resolution.policy, winner: resolution.winner, reason: resolution.reason, sourceVersion: s.version, targetVersion: t.version });
        }
      }
    }
    mergedCategories[category] = out;
  }

  const merged = {
    ...target,
    replicaId: target.replicaId,
    categories: mergedCategories,
    replicaVersion: maxVersion + 1,
    updatedAt: now,
    version: (target.version ?? 0) + 1,
  };
  return { merged, resolutions, merges, audit: { source: source.replicaId, target: target.replicaId, categories, resolved: resolutions.length, merged: merges.length, at: now } };
}

/** Validate a merged snapshot is a superset of both parents (per category). @throws {MergeError} */
export function validateMerge(merged, source, target, categories = ALL_CATEGORIES) {
  for (const category of categories) {
    const m = Object.keys(merged.categories?.[category] ?? {}).length;
    const s = Object.keys(source.categories?.[category] ?? {}).length;
    const t = Object.keys(target.categories?.[category] ?? {}).length;
    if (m < Math.max(s, t)) throw new MergeError(`merge lost entities in "${category}"`, { details: { category, merged: m, source: s, target: t } });
  }
  return merged;
}

/** A stable fingerprint of a merged snapshot (proves determinism across runs). */
export function mergeFingerprint(merged, categories = ALL_CATEGORIES) {
  const material = categories
    .map((c) => {
      const recs = merged.categories?.[c] ?? {};
      return `${c}:` + Object.keys(recs).sort().map((id) => `${id}@${recs[id].version}#${recs[id].contentHash}`).join(",");
    })
    .join("|");
  return hashContent(material);
}

// === record-level merge helpers ===========================================

function mergeReaders(a = {}, b = {}) {
  const out = {};
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    out[id] = laterIso(a[id], b[id]);
  }
  return out;
}

function mergeAttachmentMeta(a = {}, b = {}, ra, rb) {
  return {
    size: Math.max(a.size ?? 0, b.size ?? 0),
    chunkCount: Math.max(a.chunkCount ?? 0, b.chunkCount ?? 0),
    mimeType: a.mimeType ?? b.mimeType ?? null,
    checksum: (compareStamps(ra, rb) === StampOrder.DOMINATED ? b : a).checksum ?? a.checksum ?? b.checksum ?? null,
    thumbnailHash: a.thumbnailHash ?? b.thumbnailHash ?? null,
  };
}

function mergeMetaFields(a, b, ra, rb) {
  if (a === undefined && b === undefined) return undefined;
  const A = a ?? {};
  const B = b ?? {};
  const laterRec = (compareStamps(ra, rb) === StampOrder.DOMINATED ? B : A); // record that wins scalar ties
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const out = {};
  for (const k of keys) {
    const va = A[k];
    const vb = B[k];
    if (va === undefined) out[k] = vb;
    else if (vb === undefined) out[k] = va;
    else if (typeof va === "number" && typeof vb === "number") out[k] = Math.max(va, vb);
    else if (Array.isArray(va) && Array.isArray(vb)) out[k] = [...new Set([...va, ...vb].map((x) => JSON.stringify(x)))].sort().map((x) => JSON.parse(x));
    else if (isPlainObject(va) && isPlainObject(vb)) out[k] = mergeMetaFields(va, vb, ra, rb);
    else out[k] = laterRec[k]; // scalar conflict → the later-updated record's value (deterministic)
  }
  return out;
}

function lwwWinner(a, b) {
  const cmp = compareIso(a.updatedAt, b.updatedAt);
  if (cmp > 0) return a;
  if (cmp < 0) return b;
  return String(a.writerReplicaId) >= String(b.writerReplicaId) ? a : b; // deterministic tie-break
}

function laterIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return compareIso(a, b) >= 0 ? a : b;
}

function compareIso(a, b) {
  const ta = new Date(a ?? 0).getTime();
  const tb = new Date(b ?? 0).getTime();
  return ta === tb ? 0 : ta > tb ? 1 : -1;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export { stableStringify };

/**
 * @module replication/versions
 *
 * **Replica version management.** A per-entity VERSION STAMP orders the same entity across replicas so
 * the system can tell a *fast-forward* (one replica is strictly newer) from a genuine *concurrent*
 * divergence (a conflict). This sprint uses a SCALAR stamp — `version` (a monotonic counter) +
 * `contentHash` (an opaque digest of the encrypted content). Same version + same hash = identical; same
 * version + different hash = concurrent → conflict; different version = fast-forward.
 *
 * @evolution `compareStamps` is the SEAM a FUTURE vector-clock implementation drops into WITHOUT
 * changing callers — the return values ({@link StampOrder}) are already the four vector-clock relations
 * (equal / dominates / dominated / concurrent). This sprint does NOT implement vector clocks, CRDTs, or
 * consensus.
 *
 * @security A stamp carries a version + a writer id + a timestamp + an opaque content hash — never
 * plaintext or keys. The hash reveals nothing about content; it only detects divergence.
 */

import crypto from "node:crypto";
import { StampOrder } from "../types/types.js";

/** The kind of stamp in use (a vector-clock impl would report "vector"). */
export const STAMP_KIND = "scalar";

/** Whether a stamp is a vector clock (always false this sprint — the seam is documented, not built). */
export function isVectorStamp() {
  return false;
}

/**
 * Compare two entity version stamps. @param {import("../types/types.js").EntityVersion} a
 * @param {import("../types/types.js").EntityVersion} b @returns {string} one of {@link StampOrder}
 */
export function compareStamps(a, b) {
  const av = a?.version ?? 0;
  const bv = b?.version ?? 0;
  if (av === bv) {
    return stampContent(a) === stampContent(b) ? StampOrder.EQUAL : StampOrder.CONCURRENT;
  }
  return av > bv ? StampOrder.DOMINATES : StampOrder.DOMINATED;
}

/** The content identity of a stamp (its hash, or a deterministic fallback from version+writer). */
export function stampContent(record) {
  if (record?.contentHash) return String(record.contentHash);
  return `v${record?.version ?? 0}:${record?.writerReplicaId ?? ""}`;
}

/** A deterministic opaque content hash over a metadata descriptor (never plaintext). */
export function hashContent(descriptor) {
  return crypto.createHash("sha256").update(typeof descriptor === "string" ? descriptor : stableStringify(descriptor ?? {})).digest("hex");
}

/**
 * Produce the NEXT version record for a local edit (incremental version update). Pure.
 * @param {import("../types/types.js").EntityVersion|null} prev @param {{ writerReplicaId, updatedAt, contentHash?, meta?, deleted? }} edit
 * @returns {import("../types/types.js").EntityVersion}
 */
export function nextVersion(prev, edit) {
  return {
    entityId: prev?.entityId ?? edit.entityId,
    version: (prev?.version ?? 0) + 1,
    writerReplicaId: String(edit.writerReplicaId),
    updatedAt: edit.updatedAt,
    contentHash: edit.contentHash ?? hashContent(edit.meta ?? { v: (prev?.version ?? 0) + 1, w: edit.writerReplicaId }),
    ...(edit.deleted !== undefined ? { deleted: !!edit.deleted } : {}),
    ...(edit.meta !== undefined ? { meta: edit.meta } : prev?.meta !== undefined ? { meta: prev.meta } : {}),
  };
}

/** The version a MERGED record should carry (supersedes both parents deterministically). */
export function mergedVersion(a, b) {
  return Math.max(a?.version ?? 0, b?.version ?? 0) + 1;
}

/** A compact version-history entry for auditing an entity's evolution. */
export function versionHistoryEntry(category, record, at) {
  return { category, entityId: record.entityId, version: record.version, writerReplicaId: record.writerReplicaId, contentHash: record.contentHash, deleted: !!record.deleted, at: at ?? record.updatedAt };
}

/** Deterministic JSON (sorted keys) so hashes are stable across runs. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

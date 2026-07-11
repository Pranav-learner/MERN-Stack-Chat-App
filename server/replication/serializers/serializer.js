/**
 * @module replication/serializers
 *
 * Public DTOs for the State Replication subsystem. Whitelists PUBLIC fields for replicas, comparisons,
 * conflicts, resolutions, merges, and deltas. All views carry VERSION METADATA + counts + policy names
 * only — never content.
 */

import { replicaSummary } from "../replicas/replicaModel.js";

/** A replica's public DTO (per-category summary; no raw record dumps). */
export function toPublicReplica(replica) {
  if (!replica) return null;
  return { ...replicaSummary(replica), metadata: safeMetadata(replica.metadata), updatedAt: replica.updatedAt, version: replica.version, schemaVersion: replica.schemaVersion };
}

/** A comparison DTO (per-category counts + conflict/merge lists). */
export function toComparison(comparison, source, target) {
  return {
    sourceReplicaId: source?.replicaId,
    targetReplicaId: target?.replicaId,
    totals: comparison.totals,
    conflicts: comparison.conflicts.map(toConflict),
    merges: comparison.merges.map((m) => ({ category: m.category, entityId: m.entityId })),
    perCategory: Object.fromEntries(
      Object.entries(comparison.perCategory).map(([c, b]) => [c, { inSync: b.inSync, onlyInSource: b.onlyInSource.length, onlyInTarget: b.onlyInTarget.length, fastForwardTarget: b.fastForwardTarget.length, fastForwardSource: b.fastForwardSource.length, conflicts: b.conflicts.length, merges: b.merges.length }]),
    ),
  };
}

/** A conflict DTO (versions + writers; no content). */
export function toConflict(conflict) {
  return {
    category: conflict.category,
    entityId: conflict.entityId,
    source: toRecordRef(conflict.source),
    target: toRecordRef(conflict.target),
    metadata: conflict.metadata,
  };
}

/** A resolution DTO. */
export function toResolution(resolution) {
  return {
    category: resolution.category,
    entityId: resolution.entityId,
    policy: resolution.policy,
    reason: resolution.reason,
    winner: toRecordRef(resolution.winner),
    sourceVersion: resolution.sourceVersion,
    targetVersion: resolution.targetVersion,
    resolvedAt: resolution.resolvedAt,
  };
}

/** A merge-result DTO. */
export function toMergeResult({ merged, resolutions, merges, audit }) {
  return {
    merged: toPublicReplica(merged),
    resolutions: (resolutions ?? []).map((r) => ({ category: r.category, entityId: r.entityId, policy: r.policy, winner: r.winner?.writerReplicaId ?? r.winner, reason: r.reason })),
    mergedEntities: (merges ?? []).length,
    audit,
  };
}

/** A delta DTO (counts + resume metadata; records only if requested). */
export function toDelta(delta, options = {}) {
  const dto = {
    deltaId: delta.deltaId,
    sourceReplicaId: delta.sourceReplicaId,
    targetReplicaId: delta.targetReplicaId,
    totalItems: delta.totalItems,
    partial: delta.partial,
    cursor: delta.cursor,
    checksum: delta.checksum,
    createdAt: delta.createdAt,
  };
  if (options.includeRecords) dto.records = delta.records.map((r) => ({ category: r.category, ...toRecordRef(r.record) }));
  return dto;
}

/** A compact record reference (version metadata only). */
function toRecordRef(record) {
  if (!record) return null;
  return { entityId: record.entityId, version: record.version, writerReplicaId: record.writerReplicaId, updatedAt: record.updatedAt, contentHash: record.contentHash, ...(record.deleted ? { deleted: true } : {}), ...(record.meta !== undefined ? { meta: record.meta } : {}) };
}

function safeMetadata(meta) {
  return meta ?? {};
}

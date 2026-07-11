/**
 * @module replication
 *
 * **Layer 9 · Sprint 2 — State Replication & Conflict Resolution.** Turns every authenticated device
 * into a secure encrypted REPLICA and keeps replicas eventually consistent: it compares replicas,
 * detects conflicts, resolves them with configurable policies (last-write-wins / server-authority /
 * merge / custom), applies DETERMINISTIC merges (read-receipt union, delivery max-state, attachment/
 * metadata field-merge), replicates deltas (safe monotonic catch-up with replay protection), and
 * resumes interrupted synchronization (integrating the Layer-8 Transport Engine).
 *
 * @security Reasons over VERSION METADATA + entity IDs + non-secret merge metadata ONLY — never
 * plaintext, ciphertext, or keys. The `contentHash` is an opaque divergence detector.
 *
 * @evolution Extends the Layer 9 Sprint 1 Synchronization Engine (directional catch-up) with
 * bidirectional replication. Uses a SCALAR version stamp (a vector-clock seam); it does NOT implement
 * vector clocks, CRDTs, consensus, monitoring, or performance hardening (Sprint 3 / later). Group
 * replication + hybrid mode reuse this subsystem.
 *
 * @example
 * ```js
 * import { ReplicaManager, createInMemoryReplicationRepository, createReplicationApi } from "./replication/index.js";
 * const mgr = new ReplicaManager({ ...createInMemoryReplicationRepository() });
 * const api = createReplicationApi(mgr);
 * await api.registerReplica({ deviceId: "phone", userId: "u1", categories });
 * await api.synchronizeReplicas({ sourceDeviceId: "phone", targetDeviceId: "laptop", policy: "merge" });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { ReplicationEventBus } from "./events/events.js";

// Versions + replica model
export { compareStamps, nextVersion, mergedVersion, hashContent, versionHistoryEntry, StampOrder, STAMP_KIND, isVectorStamp } from "./versions/versionStamp.js";
export { createReplicaSnapshot, normalizeCategories, normalizeRecord, getRecord, setRecord, applyRecord, replicaSummary, totalEntities } from "./replicas/replicaModel.js";

// Conflicts + merge
export { classifyEntity, compareReplicas } from "./conflicts/conflictDetector.js";
export { ConflictResolver } from "./conflicts/conflictResolver.js";
export { mergeRecords, mergeReplicas, validateMerge, mergeFingerprint } from "./merge/mergeEngine.js";

// Delta + history
export { generateReplicationDelta, deltaChecksum, validateDelta, compressDelta, applyDelta, resumeDelta, planTransferResume, ReplayGuard } from "./delta/deltaReplicator.js";
export { createHistory } from "./history/history.js";

// Validators + serializers
export * from "./validators/validators.js";
export { toPublicReplica, toComparison, toConflict, toResolution, toMergeResult, toDelta } from "./serializers/serializer.js";

// Repositories
export { createInMemoryReplicationRepository } from "./repository/inMemoryReplicationRepository.js";
export { createMongoReplicationRepository } from "./repository/mongoReplicationRepository.js";

// Manager + API
export { ReplicaManager } from "./manager/replicaManager.js";
export { createReplicationApi } from "./api/replicationApi.js";

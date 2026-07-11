/**
 * @module synchronization-reliability/freeze
 *
 * **Synchronization layer freeze.** Declares the STABLE public interfaces of the WHOLE Layer 9
 * offline-synchronization + state-replication layer — Synchronization Engine (Sprint 1) + State
 * Replication (Sprint 2) + Synchronization Reliability (Sprint 3) — and the documented extension points
 * a FUTURE Layer 10 (secure group communication) may build on WITHOUT modifying the synchronization
 * architecture.
 *
 * Machine-readable manifest + compatibility helpers — the authoritative human description lives in
 * `LAYER9_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + schema/protocol versions. Any breaking change to a
 * frozen interface must bump the corresponding version here and be called out as a migration.
 */

import { SYNC_LAYER_VERSION, SYNCREL_SCHEMA_VERSION } from "../types/types.js";

/** The frozen schema/protocol versions across the Layer 9 synchronization layer (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  syncLayer: SYNC_LAYER_VERSION,
  synchronizationProtocol: "1.0", // Sprint 1 SYNC_PROTOCOL_VERSION
  synchronizationSchema: 1, // Sprint 1 SYNC_SCHEMA_VERSION
  replicationSchema: 1, // Sprint 2 REPLICATION_SCHEMA_VERSION
  reliabilitySchema: SYNCREL_SCHEMA_VERSION,
});

/**
 * The frozen public interfaces — module → the stable exported symbols Layer 10 may depend on. Adding to
 * a list is backward-compatible; removing/renaming is a breaking change requiring a version bump.
 */
export const FROZEN_INTERFACES = Object.freeze({
  synchronization: ["SynchronizationManager", "createSyncApi", "computeDelta", "createSyncPlan (deterministic)", "SyncEventBus", "Replica + SyncSession + SyncPlan models"],
  replication: ["ReplicaManager", "createReplicationApi", "compareReplicas", "ConflictResolver (LWW/authority/merge/custom)", "mergeReplicas (deterministic)", "generateReplicationDelta + ReplayGuard", "ReplicationEventBus"],
  "synchronization-reliability": ["SyncReliabilityManager", "createReliabilityApi", "RecoveryCoordinator", "retry policies", "SyncHealthMonitor", "SyncMetrics", "ReliabilityEventBus"],
});

/**
 * The documented extension points for Layer 10 — the seams to build secure group communication on top
 * of a mature single-user synchronization layer, WITHOUT modifying it.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "replication/manager", seam: "ReplicaManager.synchronizeReplicas + ConflictResolver policies", forLayer: "Layer 10 group replication reuses the per-entity version records + conflict policies across many members' replicas" },
  { module: "replication/versions", seam: "compareStamps (scalar → vector-clock seam)", forLayer: "Layer 10 group causality can drop in vector clocks here without changing callers" },
  { module: "synchronization/planner", seam: "createSyncPlan (deterministic, resumable)", forLayer: "Layer 10 fans a group sync out to per-member deterministic plans" },
  { module: "synchronization-reliability/manager", seam: "SyncReliabilityManager + injected recovery hooks + checkpoint", forLayer: "Layer 10 recovers a group sync member-by-member from the same checkpoint model" },
  { module: "synchronization-reliability/events", seam: "ReliabilityEventBus (interrupted / recovery_succeeded / completed)", forLayer: "Layer 10 drives group sync state off member sync events" },
  { module: "synchronization-reliability/monitoring", seam: "SyncMetrics.registerExporter", forLayer: "wire a Prometheus/OpenTelemetry exporter" },
]);

/** What the synchronization layer deliberately does NOT implement (the boundary Layer 10+ owns). */
export const DOES_NOT_IMPLEMENT = Object.freeze(["group-messaging", "group-replication", "crdts", "distributed-consensus", "vector-clocks", "voice-calls", "video-calls"]);

/** A machine-readable snapshot of the freeze (served by the reliability API + docs). */
export const protocolManifest = Object.freeze({
  framework: "layer-9-synchronization",
  frozen: true,
  frozenAt: "layer-9-sprint-3",
  versions: FROZEN_VERSIONS,
  interfaces: FROZEN_INTERFACES,
  extensionPoints: EXTENSION_POINTS,
  doesNotImplement: DOES_NOT_IMPLEMENT,
});

/** Whether a proposed synchronization-layer version is compatible with the frozen one (same major). */
export function isSyncLayerCompatible(version) {
  if (typeof version !== "string") return false;
  const major = (v) => v.split(".")[0];
  return major(version) === major(FROZEN_VERSIONS.syncLayer);
}

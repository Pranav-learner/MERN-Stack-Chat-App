/**
 * @module transport-reliability/freeze
 *
 * **Data Plane freeze.** Declares the STABLE public interfaces of the WHOLE Layer 8 peer-to-peer Data
 * Plane — Reliable Messaging (Sprint 1) + Transport Engine (Sprint 2) + Transport Reliability (Sprint
 * 3) — and the documented extension points a FUTURE Layer 9 (Offline Encrypted Synchronization) may
 * build on WITHOUT redesigning the transport architecture.
 *
 * Machine-readable manifest + compatibility helpers — the authoritative human description lives in
 * `LAYER8_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + schema/protocol versions. Any breaking change to a
 * frozen interface must bump the corresponding version here and be called out as a migration.
 */

import { DATA_PLANE_VERSION, TRANSREL_SCHEMA_VERSION } from "../types/types.js";

/** The frozen schema/protocol versions across the Layer 8 Data Plane (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  dataPlane: DATA_PLANE_VERSION,
  messagingProtocol: "1.0", // data-plane MESSAGING_PROTOCOL_VERSION
  messagingSchema: 1, // DATAPLANE_SCHEMA_VERSION
  transportProtocol: "1.0", // transport-engine TRANSPORT_PROTOCOL_VERSION
  transportSchema: 1, // transport-engine TRANSPORT_SCHEMA_VERSION
  reliabilitySchema: TRANSREL_SCHEMA_VERSION,
});

/**
 * The frozen public interfaces — module → the stable exported symbols Layer 9 may depend on. Adding
 * to a list is backward-compatible; removing/renaming is a breaking change requiring a version bump.
 */
export const FROZEN_INTERFACES = Object.freeze({
  "data-plane": ["MessagingEngine", "createDataPlaneService", "DataPlaneRelayService", "wire (data/ack envelopes)", "MessagingEventBus", "DataMessage model"],
  "transport-engine": ["TransportEngine", "createTransportEngineService", "TransportRelayService", "fragmentPayload", "Reassembler", "wire (chunk/chunk-ack/control envelopes)", "TransportEventBus", "Transfer + TransferChunk models"],
  "transport-reliability": ["TransportReliabilityManager", "createReliabilityApi", "RecoveryCoordinator", "planResume / advanceCheckpoint", "ConnectionMigrator", "TransferHealthMonitor", "TransferMetrics", "ReliabilityEventBus"],
});

/**
 * The documented extension points for Layer 9 — the seams to build Offline Encrypted Synchronization
 * on top of a mature Data Plane, WITHOUT modifying the transport architecture.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "data-plane/manager", seam: "MessagingEngine.send/onMessage over an INJECTED transport", forLayer: "Layer 9 replays queued offline messages through the same reliable engine when a peer reconnects" },
  { module: "transport-engine/manager", seam: "TransportEngine.startTransfer + onPayload + the transfer checkpoint", forLayer: "Layer 9 resumes a large offline transfer from its last checkpoint on reconnect" },
  { module: "transport-reliability/resume", seam: "planResume(checkpoint) + advanceCheckpoint (monotonic)", forLayer: "Layer 9 persists checkpoints durably + resumes across app restarts / sessions" },
  { module: "transport-reliability/migration", seam: "ConnectionMigrator + injected Layer-7 connection hooks", forLayer: "Layer 9 continues a sync transfer across a device network change without restarting it" },
  { module: "transport-reliability/events", seam: "ReliabilityEventBus (transfer_interrupted / recovery_succeeded / transfer_completed)", forLayer: "Layer 9 drives its sync state machine off transfer lifecycle events" },
  { module: "transport-reliability/monitoring", seam: "TransferMetrics.registerExporter", forLayer: "wire a Prometheus/OpenTelemetry exporter" },
]);

/** What the Data Plane deliberately does NOT implement (the boundary Layer 9+ owns). */
export const DOES_NOT_IMPLEMENT = Object.freeze([
  "offline-synchronization",
  "conflict-resolution",
  "group-messaging",
  "voice-calls",
  "video-calls",
  "live-streaming",
  "media-codecs",
]);

/** A machine-readable snapshot of the freeze (served by the reliability API + docs). */
export const protocolManifest = Object.freeze({
  framework: "layer-8-data-plane",
  frozen: true,
  frozenAt: "layer-8-sprint-3",
  versions: FROZEN_VERSIONS,
  interfaces: FROZEN_INTERFACES,
  extensionPoints: EXTENSION_POINTS,
  doesNotImplement: DOES_NOT_IMPLEMENT,
});

/** Whether a proposed Data Plane version is compatible with the frozen one (same major). */
export function isDataPlaneCompatible(version) {
  if (typeof version !== "string") return false;
  const major = (v) => v.split(".")[0];
  return major(version) === major(FROZEN_VERSIONS.dataPlane);
}

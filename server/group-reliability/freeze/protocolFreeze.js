/**
 * @module group-reliability/freeze
 *
 * **Layer 10 Group platform freeze.** Declares the STABLE public interfaces of the WHOLE Layer 10
 * Secure Group Communication platform — Group Foundation (Sprint 1) + Group Communication Engine
 * (Sprint 2) + Group Reliability (Sprint 3) — and the documented extension points a FUTURE Sprint 4
 * (Group Delivery & Read Receipt Engine) may build on WITHOUT modifying the group architecture.
 *
 * Machine-readable manifest + compatibility helpers — the authoritative human description lives in
 * `LAYER10_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + schema/protocol versions. Any breaking change to a
 * frozen interface must bump the corresponding version here and be called out as a migration.
 */

import { GROUP_LAYER_VERSION, GROUPREL_SCHEMA_VERSION } from "../types/types.js";

/** The frozen schema/protocol versions across the Layer 10 group platform (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  groupLayer: GROUP_LAYER_VERSION,
  groupFoundationSchema: 1, // Sprint 1 GROUP_SCHEMA_VERSION
  groupCommunicationSchema: 1, // Sprint 2 GROUP_COMM_SCHEMA_VERSION
  reliabilitySchema: GROUPREL_SCHEMA_VERSION,
});

/**
 * The frozen public interfaces — module → the stable exported symbols Sprint 4 may depend on. Adding to
 * a list is backward-compatible; removing/renaming is a breaking change requiring a version bump.
 */
export const FROZEN_INTERFACES = Object.freeze({
  group: ["GroupManager", "createGroupApi", "membership lifecycle FSM", "ranked RBAC + permission matrix", "version vector", "GroupEventBus", "Group + Membership + replica models"],
  "group-communication": ["GroupCommunicationEngine", "createGroupCommunicationApi", "GroupKeyManager (versioned epochs)", "membership rekeying (fresh-on-departure)", "fan-out planner (per-device legs)", "group synchronization (facet delta)", "GroupCommEventBus", "delivery legs (Sprint-4 receipt seam)"],
  "group-reliability": ["GroupReliabilityManager", "createGroupReliabilityApi", "RecoveryCoordinator", "retry policies", "GroupHealthMonitor + scoreGroupHealth", "GroupMetrics", "GroupReliabilityEventBus"],
});

/**
 * The documented extension points for Sprint 4 — the seams to build the Group Delivery & Read Receipt
 * Engine on top of a mature group platform, WITHOUT modifying it.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "group-communication/delivery", seam: "per-device delivery legs (planned→queued/dispatched→delivered) + GroupCommEventType.DELIVERY_UPDATED", forLayer: "Sprint 4 aggregates per-member delivery legs into ✓ / ✓✓ / ✓✓-blue receipts" },
  { module: "group-communication/events", seam: "GroupCommEventBus (message_sent / delivery_updated / message_received)", forLayer: "Sprint 4 drives receipt state off delivery events without polling" },
  { module: "group-reliability/events", seam: "GroupReliabilityEventBus (completed / interrupted / recovered)", forLayer: "Sprint 4 knows when a fan-out is reliably complete before finalizing a receipt" },
  { module: "group-reliability/manager", seam: "GroupReliabilityManager.checkpoint (target counts) + resume", forLayer: "Sprint 4 reuses the target/checkpoint model to track per-member delivery at scale" },
  { module: "group-reliability/monitoring", seam: "GroupMetrics.registerExporter", forLayer: "wire a Prometheus/OpenTelemetry exporter for receipt metrics" },
  { module: "group-reliability/health", seam: "scoreGroupHealth (per-type aggregate)", forLayer: "Sprint 4 surfaces receipt-delivery health alongside operation health" },
]);

/** What the group platform deliberately does NOT implement (the boundary Sprint 4 / Layer 11 own). */
export const DOES_NOT_IMPLEMENT = Object.freeze(["group-read-receipts", "delivery-aggregation", "per-member-delivery-tracking", "blue-tick-logic", "voice-calls", "video-calls"]);

/** A machine-readable snapshot of the freeze (served by the reliability API + docs). */
export const protocolManifest = Object.freeze({
  framework: "layer-10-secure-group-communication",
  frozen: true,
  frozenAt: "layer-10-sprint-3",
  versions: FROZEN_VERSIONS,
  interfaces: FROZEN_INTERFACES,
  extensionPoints: EXTENSION_POINTS,
  doesNotImplement: DOES_NOT_IMPLEMENT,
});

/** Whether a proposed group-layer version is compatible with the frozen one (same major). */
export function isGroupLayerCompatible(version) {
  if (typeof version !== "string") return false;
  const major = (v) => v.split(".")[0];
  return major(version) === major(FROZEN_VERSIONS.groupLayer);
}

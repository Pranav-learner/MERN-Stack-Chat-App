/**
 * @module network-reliability/freeze
 *
 * **Connectivity control-plane freeze.** Declares the STABLE public interfaces of the Layer 7
 * connectivity layer (Network Discovery + the Connectivity Engine / Connection Manager + Network
 * Reliability) and the documented extension points a FUTURE Layer 8 (P2P messaging, media transfer,
 * real-time comms) may build on WITHOUT redesigning the networking architecture.
 *
 * Machine-readable manifest + compatibility helpers — the authoritative human description lives in
 * `LAYER7_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + schema versions. Any breaking change to a frozen
 * interface must bump the corresponding version here and be called out as a migration.
 */

import { CONNECTIVITY_VERSION } from "../types/types.js";

/** The frozen schema/protocol versions across the Layer 7 stack (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  connectivity: CONNECTIVITY_VERSION,
  networkDiscoverySchema: 1, // NETDISC_SCHEMA_VERSION
  candidateModel: "rfc8445", // ICE-style candidate shape
  reliabilitySchema: 1, // NETREL_SCHEMA_VERSION
  stunProtocol: "rfc5389",
});

/**
 * The frozen public interfaces — module → the stable exported symbols Layer 8 may depend on. Adding
 * to a list is backward-compatible; removing/renaming is a breaking change requiring a version bump.
 */
export const FROZEN_INTERFACES = Object.freeze({
  "network-discovery": ["NetworkDiscoveryManager", "createDiscoveryApi", "NetworkProfile model", "ConnectionCandidate model (RFC 8445)", "StunClient", "DiscoveryEventBus"],
  connectivity: ["ActiveConnection model", "Connection Manager (establish/close)", "candidate-pair selection", "TURN relay fallback"],
  "network-reliability": ["NetworkReliabilityManager", "createReliabilityApi", "RecoveryCoordinator", "HeartbeatMonitor", "retry policies", "ReliabilityEventBus", "health monitor"],
});

/**
 * The documented extension points for Layer 8 — the seams to build direct P2P messaging / media /
 * real-time comms on top of a HEALTHY Active Connection, without touching the connectivity layer.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "network-reliability/manager", seam: "ActiveConnection (state=connected, health=healthy) + its sessionId", forLayer: "Layer 8 opens application data channels over a healthy connection, encrypting with the Layer-5 session keys" },
  { module: "network-reliability/events", seam: "ReliabilityEventBus (connection_state_changed / health_changed / recovery_succeeded)", forLayer: "Layer 8 pauses/resumes app streams as the connection degrades + recovers" },
  { module: "network-reliability/recovery", seam: "recovery hooks + sessionPreserved flag", forLayer: "Layer 8 resumes app streams over a recovered connection without a re-handshake" },
  { module: "network-reliability/health", seam: "ConnectionHealth (packetLoss + jitter placeholders)", forLayer: "Layer 8 media adds real packet-loss/jitter/quality signals here" },
  { module: "network-reliability/observability", seam: "ReliabilityMetrics.registerExporter", forLayer: "wire a Prometheus/OpenTelemetry exporter" },
]);

/** A machine-readable snapshot of the freeze (served by the reliability API + docs). */
export const protocolManifest = Object.freeze({
  framework: "layer-7-connectivity",
  frozen: true,
  frozenAt: "layer-7-sprint-3",
  versions: FROZEN_VERSIONS,
  interfaces: FROZEN_INTERFACES,
  extensionPoints: EXTENSION_POINTS,
  doesNotImplement: ["p2p-messaging", "data-channels", "media-streaming", "file-transfer", "application-messaging"],
});

/** Whether a proposed connectivity version is compatible with the frozen one (same major). */
export function isConnectivityCompatible(version) {
  if (typeof version !== "string") return false;
  const major = (v) => v.split(".")[0];
  return major(version) === major(FROZEN_VERSIONS.connectivity);
}

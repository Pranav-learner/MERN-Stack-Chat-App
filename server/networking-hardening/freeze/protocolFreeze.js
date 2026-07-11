/**
 * @module networking-hardening/freeze
 *
 * **Networking control-plane freeze.** Declares the STABLE public interfaces of the Layer 6
 * networking control plane (Discovery, Presence, Capabilities, Peer Discovery Protocol, Endpoint
 * Selection) and the documented extension points a FUTURE Layer 7 (NAT Traversal / ICE / STUN /
 * TURN / WebRTC / relay / P2P) may build on WITHOUT redesigning the architecture.
 *
 * This is a machine-readable manifest + compatibility helpers — the authoritative human description
 * lives in `LAYER6_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + schema/protocol versions. Any breaking change to a
 * frozen interface must bump the corresponding version here and be called out as a migration.
 */

import { NETWORKING_CONTROL_PLANE_VERSION } from "../types/types.js";

/** The frozen schema/protocol versions across the Layer 6 stack (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  controlPlane: NETWORKING_CONTROL_PLANE_VERSION,
  discoverySchema: 1, // DISCOVERY_SCHEMA_VERSION
  presenceSchema: 1, // PRESENCE_SCHEMA_VERSION
  capabilitySchema: 1, // CAPABILITY_SCHEMA_VERSION
  pdpSchema: 1, // PDP_SCHEMA_VERSION
  endpointSelectionSchema: 1, // ES_SCHEMA_VERSION
  protocolVersion: "1.0", // capability protocol/crypto negotiation version
  pdpProtocolVersion: "1.0", // PDP_PROTOCOL_VERSION
});

/**
 * The frozen public interfaces — module → the stable exported symbols Layer 7 may depend on. Adding
 * to a list is backward-compatible; removing/renaming is a breaking change requiring a version bump.
 */
export const FROZEN_INTERFACES = Object.freeze({
  "peer-discovery": ["DiscoveryManager", "createDiscoveryApi", "DiscoveryEventBus", "DiscoveryState", "connection/transport placeholders"],
  presence: ["PresenceManager", "createPresenceApi", "HeartbeatMonitor", "PresenceEventBus", "PresenceStatus", "createPresenceService"],
  capabilities: ["CapabilityManager", "createCapabilityApi", "negotiateCapabilities", "TransportPolicy", "CapabilityEventBus", "p2p placeholder"],
  "peer-discovery-protocol": ["PeerDiscoveryManager", "createPdpApi", "ConnectionPlan model", "runDiscoveryWorkflow", "PdpEventBus", "connection/nat placeholders"],
  "endpoint-selection": ["EndpointSelectionManager", "createEndpointApi", "EndpointConnectionPlan model", "scoring dimensions (extensible)", "SelectionPolicy", "EndpointEventBus", "nat placeholder"],
  "networking-hardening": ["NetworkingMetrics", "NetworkMonitor", "RecoveryCoordinator", "RateLimiter", "ResilientRepository", "consistency helpers"],
});

/**
 * The documented extension points for Layer 7 — the seams to build on without touching the frozen
 * control plane. Each names the module, the seam, and what a future layer plugs in.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "presence/advertisement", seam: "connection + transport placeholders (inert)", forLayer: "Layer 7 fills reachability (endpoints, protocols) once NAT traversal exists" },
  { module: "capabilities/advertisement", seam: "p2p placeholder + transport-preference policies", forLayer: "Layer 7 fills NAT-traversal methods (ICE/STUN/TURN) + real WebRTC/QUIC transports" },
  { module: "peer-discovery-protocol/planner", seam: "ConnectionPlan.connection + ConnectionPlan.nat placeholders", forLayer: "Layer 7 fills ICE candidates + relays and establishes the connection" },
  { module: "endpoint-selection/scorer", seam: "networkQuality + natType scoring dimensions (neutral)", forLayer: "Layer 7 makes selection NAT-aware by populating these dimensions" },
  { module: "endpoint-selection/planner", seam: "EndpointConnectionPlan.nat placeholder + retryStrategy", forLayer: "Layer 7 walks priorityOrder/retryStrategy to establish + fail over connections" },
  { module: "networking-hardening/observability", seam: "NetworkingMetrics.registerExporter", forLayer: "wire a Prometheus/OpenTelemetry exporter" },
  { module: "networking-hardening/events", seam: "HardeningEventBus + each subsystem EventBus", forLayer: "external monitoring/alerting + Layer 7 signaling consume these" },
]);

/** A machine-readable snapshot of the freeze (served by the hardening API + docs). */
export const protocolManifest = Object.freeze({
  framework: "layer-6-networking-control-plane",
  frozen: true,
  frozenAt: "layer-6-sprint-6",
  versions: FROZEN_VERSIONS,
  interfaces: FROZEN_INTERFACES,
  extensionPoints: EXTENSION_POINTS,
  doesNotImplement: ["nat-traversal", "ice", "stun", "turn", "webrtc", "p2p", "socket-creation", "relay-connections"],
});

/**
 * Whether a proposed control-plane version is compatible with the frozen one (same major).
 * @param {string} version @returns {boolean}
 */
export function isControlPlaneCompatible(version) {
  if (typeof version !== "string") return false;
  const major = (v) => v.split(".")[0];
  return major(version) === major(FROZEN_VERSIONS.controlPlane);
}

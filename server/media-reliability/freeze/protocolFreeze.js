/**
 * @module media-reliability/freeze
 *
 * **Layer 11 Media platform freeze.** Declares the STABLE public interfaces of the WHOLE Layer 11 Secure
 * Media Platform — Secure Media Pipeline (Sprint 1) + Media Delivery Engine (Sprint 2) + Media
 * Reliability (Sprint 3) — and the documented extension points a FUTURE Layer 12 (Distributed Hybrid
 * Architecture) may build on WITHOUT modifying the media architecture.
 *
 * Machine-readable manifest + compatibility helpers — the authoritative human description lives in
 * `LAYER11_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + schema/protocol versions. Any breaking change to a frozen
 * interface must bump the corresponding version here and be called out as a migration.
 */

import { MEDIA_LAYER_VERSION, MEDIAREL_SCHEMA_VERSION } from "../types/types.js";

/** The frozen schema/protocol versions across the Layer 11 media platform (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  mediaLayer: MEDIA_LAYER_VERSION,
  mediaPipelineSchema: 1, // Sprint 1 MEDIA_SCHEMA_VERSION
  mediaDeliverySchema: 1, // Sprint 2 MEDIA_DELIVERY_SCHEMA_VERSION
  reliabilitySchema: MEDIAREL_SCHEMA_VERSION,
});

/**
 * The frozen public interfaces — module → the stable exported symbols Layer 12 may depend on. Adding to a
 * list is backward-compatible; removing/renaming is a breaking change requiring a version bump.
 */
export const FROZEN_INTERFACES = Object.freeze({
  media: ["MediaManager", "createMediaApi", "media encryption (device-local AES-256-GCM)", "StorageManager + provider interface (store/retrieve/delete/head)", "integrity verifier", "MediaEventBus", "MediaMetadata + MediaOperation models"],
  "media-delivery": ["MediaDeliveryEngine", "createDeliveryApi", "streaming session FSM + StreamBuffer", "progressive transfers (window + resume)", "thumbnail/preview engines (async pluggable)", "media sync (availability + offline queue)", "TransferScheduler", "MediaDeliveryEventBus", "media gateway (ciphertext → chunks)"],
  "media-reliability": ["MediaReliabilityManager", "createMediaReliabilityApi", "RecoveryCoordinator", "retry policies", "MediaHealthMonitor + scoreMediaHealth", "MediaMetrics", "MediaCache", "MediaReliabilityEventBus"],
});

/**
 * The documented extension points for Layer 12 — the seams to build the Distributed Hybrid Architecture
 * on top of a mature media platform, WITHOUT modifying it.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "media/storage", seam: "StorageManager + the pluggable storage-provider interface", forLayer: "Layer 12 plugs decentralized / hybrid / edge-cache storage providers WITHOUT changing media business logic" },
  { module: "media-delivery/manager/mediaGateway", seam: "ciphertext → chunk gateway (storage-independent)", forLayer: "Layer 12 fetches media chunks from any hybrid source (peer / edge / origin) through the same gateway" },
  { module: "media-reliability/recovery", seam: "RecoveryCoordinator + injected recovery hooks + monotonic checkpoint", forLayer: "Layer 12 recovers a hybrid transfer across sources from the same checkpoint model" },
  { module: "media-reliability/events", seam: "MediaReliabilityEventBus (completed / interrupted / recovered)", forLayer: "Layer 12 drives hybrid-routing decisions off media-operation events without polling" },
  { module: "media-reliability/monitoring", seam: "MediaMetrics.registerExporter", forLayer: "wire a Prometheus/OpenTelemetry exporter for hybrid-transfer metrics" },
  { module: "media-reliability/cache", seam: "MediaCache (TTL/LRU + distributed hooks)", forLayer: "Layer 12 backs the cache with a distributed edge cache via the { get, set, del } hooks" },
]);

/** What the media platform deliberately does NOT implement (the boundary Layer 12 owns). */
export const DOES_NOT_IMPLEMENT = Object.freeze(["voice-calls", "video-calls", "screen-sharing", "real-time-media", "media-codecs", "webrtc-media", "hybrid-routing"]);

/** A machine-readable snapshot of the freeze (served by the reliability API + docs). */
export const protocolManifest = Object.freeze({
  framework: "layer-11-secure-media-platform",
  frozen: true,
  frozenAt: "layer-11-sprint-3",
  versions: FROZEN_VERSIONS,
  interfaces: FROZEN_INTERFACES,
  extensionPoints: EXTENSION_POINTS,
  doesNotImplement: DOES_NOT_IMPLEMENT,
});

/** Whether a proposed media-layer version is compatible with the frozen one (same major). */
export function isMediaLayerCompatible(version) {
  if (typeof version !== "string") return false;
  const major = (v) => v.split(".")[0];
  return major(version) === major(FROZEN_VERSIONS.mediaLayer);
}

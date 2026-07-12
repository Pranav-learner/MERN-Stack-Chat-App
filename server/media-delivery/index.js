/**
 * @module media-delivery
 *
 * **Layer 11 · Sprint 2 — Distributed Media Delivery & Streaming.** An INDEPENDENT engine on top of the
 * frozen Sprint-1 Secure Media Pipeline that delivers encrypted media efficiently: progressive downloads/
 * uploads, streaming sessions (buffer + seek/pause/resume), async pluggable thumbnail + preview
 * generation, multi-device media synchronization, and transfer optimization.
 *
 * @security A BLIND relay: it moves OPAQUE ciphertext in chunks (each with a per-chunk hash so integrity
 * is preserved) + control-plane metadata ONLY — it NEVER decrypts or handles keys. It reads ciphertext
 * through the Sprint-1 pipeline (storage-independent); the device reassembles + decrypts.
 *
 * @evolution Reuses Layer 8 (chunking / transfer-window), Layer 9 (media-availability sync), and the
 * Sprint-1 pipeline. It does NOT implement voice/video calls, screen sharing, real-time media, or codecs
 * (Sprint 3 / Layer 12) — preview/thumbnail generation is pluggable + async, defaulting to metadata-only.
 *
 * @example
 * ```js
 * import { MediaDeliveryEngine, createInMemoryDeliveryRepository, createDeliveryApi } from "./media-delivery/index.js";
 * const engine = new MediaDeliveryEngine({ ...createInMemoryDeliveryRepository(), mediaManager });
 * const api = createDeliveryApi(engine);
 * const { session } = await api.startStreaming({ mediaId, deviceId: "phone" });
 * const { chunk } = await api.streamChunk({ sessionId: session.sessionId, index: 0 });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { MediaDeliveryEventBus } from "./events/events.js";

// Buffering + streaming + progressive
export { StreamBuffer } from "./buffering/buffer.js";
export { createStreamingSession, transitionStreaming, applyBufferSnapshot, canStreamTransition, assertStreamTransition } from "./streaming/streamingSession.js";
export { createTransfer, transitionTransfer, receiveChunk, missingChunks, nextWindow, transferProgress, canTransferTransition, assertTransferTransition } from "./progressive/progressiveTransfer.js";

// Thumbnails + previews
export { createPreviewRecord, runGeneration, kindForContentType, defaultThumbnailGenerator } from "./thumbnails/thumbnailEngine.js";
export { defaultPreviewGenerator, PreviewCache } from "./previews/previewEngine.js";

// Synchronization + optimization
export { buildAvailabilityReplica, computeMediaDelta, createMediaSyncPlan, remainingSyncOps, markAvailable } from "./synchronization/mediaSync.js";
export { TransferScheduler } from "./optimization/transferOptimizer.js";

// Gateway + validators + serializers + dto
export { createMediaGateway } from "./manager/mediaGateway.js";
export * from "./validators/validators.js";
export { toSessionView, toChunkView, toTransferView, toPreviewView, toSyncPlanView, toReplicaView } from "./serializers/serializers.js";
export * from "./dto/dto.js";

// Repositories
export { createInMemoryDeliveryRepository } from "./repository/inMemoryDeliveryRepository.js";
export { createMongoDeliveryRepository } from "./repository/mongoDeliveryRepository.js";

// Engine + API
export { MediaDeliveryEngine } from "./manager/mediaDeliveryEngine.js";
export { createDeliveryApi } from "./api/deliveryApi.js";

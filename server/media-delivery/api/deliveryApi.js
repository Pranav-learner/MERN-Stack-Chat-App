/**
 * @module media-delivery/api
 *
 * The stable **media-delivery service facade** the HTTP controller delegates to. Wraps the
 * {@link MediaDeliveryEngine} with a flat, DTO-normalizing surface: start/seek/pause/resume/cancel
 * streaming + fetch a chunk; start/fetch/upload/complete/resume/cancel progressive transfers; generate +
 * read previews/thumbnails; register availability + synchronize devices + offline queue; prefetch +
 * optimize + diagnostics.
 *
 * @security Reads return control-plane metadata; chunk endpoints return OPAQUE ciphertext + per-chunk
 * hash for device-side reassembly/decryption (no keys). Every mutating op is owner/device-scoped in the
 * engine.
 */

import { normalizeStartStreaming, normalizeChunk, normalizeSeek, normalizeTransfer, normalizePreview, normalizeSync } from "../dto/dto.js";

export function createDeliveryApi(engine) {
  return {
    // streaming
    startStreaming: (params) => engine.startStreaming(normalizeStartStreaming(params)),
    streamChunk: (params) => engine.streamChunk(normalizeChunk(params)),
    seek: (params) => engine.seek(normalizeSeek(params)),
    pauseStreaming: ({ sessionId, actorId }) => engine.pauseStreaming({ sessionId, actorId }),
    resumeStreaming: ({ sessionId, actorId }) => engine.resumeStreaming({ sessionId, actorId }),
    cancelStreaming: ({ sessionId, actorId }) => engine.cancelStreaming({ sessionId, actorId }),
    getStreamingStatus: ({ sessionId }) => engine.getStreamingStatus({ sessionId }),

    // progressive transfers
    startTransfer: (params) => engine.startTransfer(normalizeTransfer(params)),
    fetchChunk: (params) => engine.fetchChunk(normalizeChunk(params)),
    uploadChunk: ({ transferId, index, data, hash, actorId }) => engine.uploadChunk({ transferId, index, data, hash, actorId }),
    completeUpload: ({ transferId, upload, actorId }) => engine.completeUpload({ transferId, upload, actorId }),
    resumeTransfer: ({ transferId, actorId }) => engine.resumeTransfer({ transferId, actorId }),
    pauseTransfer: ({ transferId, actorId }) => engine.pauseTransfer({ transferId, actorId }),
    cancelTransfer: ({ transferId, actorId }) => engine.cancelTransfer({ transferId, actorId }),
    getTransferStatus: ({ transferId }) => engine.getTransferStatus({ transferId }),

    // thumbnails + previews
    generateThumbnail: (params) => engine.generateThumbnail(normalizePreview(params)),
    generatePreview: (params) => engine.generatePreview(normalizePreview(params)),
    getPreview: ({ mediaId, kind, actorId }) => engine.getPreview({ mediaId, kind, actorId }),

    // synchronization
    registerAvailability: ({ deviceId, actorId, available }) => engine.registerAvailability({ deviceId, actorId, available }),
    synchronizeDevice: (params) => engine.synchronizeDevice({ ...normalizeSync(params), authoritativeMedia: params.authoritativeMedia }),
    markMediaAvailable: ({ deviceId, mediaId, actorId }) => engine.markMediaAvailable({ deviceId, mediaId, actorId }),
    getOfflineQueue: ({ deviceId }) => engine.getOfflineQueue({ deviceId }),

    // optimization + diagnostics
    prefetch: ({ candidates }) => engine.prefetch({ candidates }),
    optimizeTransfers: () => engine.optimizeTransfers(),
    bandwidthMetrics: () => engine.bandwidthMetrics(),
    getDiagnostics: ({ mediaId }) => engine.getDiagnostics({ mediaId }),
    health: () => engine.health(),
  };
}

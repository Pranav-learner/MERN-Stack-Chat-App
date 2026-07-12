/**
 * @module media-delivery/types
 *
 * Enums + constants for the **Distributed Media Delivery & Streaming** subsystem — Layer 11, Sprint 2.
 * It sits ON TOP of the frozen Sprint-1 Secure Media Pipeline as an INDEPENDENT engine that delivers
 * encrypted media efficiently: progressive downloads/uploads, streaming sessions with a buffer + seek,
 * async pluggable thumbnail + preview generation, multi-device media synchronization, and transfer
 * optimization.
 *
 * @security This subsystem moves OPAQUE ciphertext (in chunks) + control-plane metadata ONLY — it NEVER
 * decrypts or inspects media, and never touches key material. It obtains ciphertext through the Sprint-1
 * pipeline (which already verified integrity) and slices it into transport chunks; the device reassembles
 * + decrypts. Integrity is PRESERVED — a chunk carries a per-chunk hash, and the whole-object hash is
 * still verified by Sprint 1.
 *
 * @evolution Storage-INDEPENDENT: the engine reads ciphertext through an injected media gateway (built
 * over the Sprint-1 MediaManager), so it works with ANY storage provider. It reuses Layer 8 (chunking /
 * transfer-window concepts) + Layer 9 (media-availability sync). It does NOT implement voice/video
 * calls, screen sharing, real-time media, or codecs (Sprint 3 / Layer 12) — preview/thumbnail generation
 * is pluggable + async, defaulting to metadata-only placeholders.
 */

// === streaming ============================================================

/** The state of a streaming SESSION (a validated FSM). @readonly @enum {string} */
export const StreamingState = Object.freeze({
  IDLE: "idle", // created, not yet buffering
  BUFFERING: "buffering", // filling the buffer window
  PLAYING: "playing", // actively delivering chunks
  PAUSED: "paused", // paused by the client
  SEEKING: "seeking", // repositioning the cursor
  COMPLETED: "completed", // all chunks delivered (terminal)
  FAILED: "failed", // a delivery failure (terminal)
  CANCELLED: "cancelled", // stopped by the client (terminal)
});

export const ALL_STREAMING_STATES = Object.freeze(Object.values(StreamingState));

/** Allowed streaming transitions. */
export const STREAMING_TRANSITIONS = Object.freeze({
  [StreamingState.IDLE]: [StreamingState.BUFFERING, StreamingState.PLAYING, StreamingState.CANCELLED, StreamingState.FAILED],
  [StreamingState.BUFFERING]: [StreamingState.PLAYING, StreamingState.PAUSED, StreamingState.SEEKING, StreamingState.COMPLETED, StreamingState.FAILED, StreamingState.CANCELLED],
  [StreamingState.PLAYING]: [StreamingState.BUFFERING, StreamingState.PAUSED, StreamingState.SEEKING, StreamingState.COMPLETED, StreamingState.FAILED, StreamingState.CANCELLED],
  [StreamingState.PAUSED]: [StreamingState.PLAYING, StreamingState.BUFFERING, StreamingState.SEEKING, StreamingState.CANCELLED, StreamingState.FAILED],
  [StreamingState.SEEKING]: [StreamingState.BUFFERING, StreamingState.PLAYING, StreamingState.PAUSED, StreamingState.FAILED, StreamingState.CANCELLED],
  [StreamingState.COMPLETED]: [],
  [StreamingState.FAILED]: [StreamingState.BUFFERING], // resume from failure
  [StreamingState.CANCELLED]: [],
});

export const ACTIVE_STREAMING_STATES = Object.freeze([StreamingState.IDLE, StreamingState.BUFFERING, StreamingState.PLAYING, StreamingState.PAUSED, StreamingState.SEEKING]);
export const TERMINAL_STREAMING_STATES = Object.freeze([StreamingState.COMPLETED, StreamingState.CANCELLED]);

// === progressive transfers ================================================

/** A progressive transfer direction. @readonly @enum {string} */
export const TransferDirection = Object.freeze({ DOWNLOAD: "download", UPLOAD: "upload" });

/** The state of a progressive transfer. @readonly @enum {string} */
export const TransferState = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const ALL_TRANSFER_STATES = Object.freeze(Object.values(TransferState));

export const TRANSFER_TRANSITIONS = Object.freeze({
  [TransferState.PENDING]: [TransferState.ACTIVE, TransferState.CANCELLED],
  [TransferState.ACTIVE]: [TransferState.PAUSED, TransferState.COMPLETED, TransferState.FAILED, TransferState.CANCELLED],
  [TransferState.PAUSED]: [TransferState.ACTIVE, TransferState.CANCELLED],
  [TransferState.FAILED]: [TransferState.ACTIVE, TransferState.CANCELLED], // resume/retry
  [TransferState.COMPLETED]: [],
  [TransferState.CANCELLED]: [],
});

// === previews + thumbnails ================================================

/** The kind of preview/thumbnail. @readonly @enum {string} */
export const PreviewKind = Object.freeze({
  IMAGE_THUMBNAIL: "image-thumbnail",
  VIDEO_THUMBNAIL: "video-thumbnail",
  DOCUMENT_PREVIEW: "document-preview",
  AUDIO_ARTWORK: "audio-artwork", // placeholder
});

export const ALL_PREVIEW_KINDS = Object.freeze(Object.values(PreviewKind));

/** The async generation state of a preview/thumbnail. @readonly @enum {string} */
export const PreviewState = Object.freeze({
  PENDING: "pending", // requested, generator not yet run
  GENERATING: "generating", // the pluggable generator is running (async)
  READY: "ready", // generated + cached
  FAILED: "failed", // generation failed (corrupted source / generator error)
});

export const ALL_PREVIEW_STATES = Object.freeze(Object.values(PreviewState));

/** Which content types map to which preview kind (default policy). */
export const CONTENT_PREVIEW_KIND = Object.freeze([
  { prefix: "image/", kind: PreviewKind.IMAGE_THUMBNAIL },
  { prefix: "video/", kind: PreviewKind.VIDEO_THUMBNAIL },
  { prefix: "audio/", kind: PreviewKind.AUDIO_ARTWORK },
  { prefix: "application/pdf", kind: PreviewKind.DOCUMENT_PREVIEW },
  { prefix: "application/", kind: PreviewKind.DOCUMENT_PREVIEW },
  { prefix: "text/", kind: PreviewKind.DOCUMENT_PREVIEW },
]);

// === optimization =========================================================

/** Transfer priority — drives scheduling order. @readonly @enum {string} */
export const TransferPriority = Object.freeze({ HIGH: "high", NORMAL: "normal", LOW: "low", PREFETCH: "prefetch" });
export const PRIORITY_WEIGHT = Object.freeze({ high: 3, normal: 2, low: 1, prefetch: 0 });
export const ALL_PRIORITIES = Object.freeze(Object.values(TransferPriority));

// === media synchronization (reuses Layer 9 concepts) ======================

/** The availability of a media object on a device. @readonly @enum {string} */
export const MediaAvailability = Object.freeze({
  AVAILABLE: "available", // fully downloaded + decryptable on the device
  PENDING: "pending", // queued for download (offline media queue)
  MISSING: "missing", // known to exist but not on the device
});

export const ALL_AVAILABILITY = Object.freeze(Object.values(MediaAvailability));

// === events ===============================================================

/** Media-delivery event types (a FUTURE Sprint 3 consumes these). @readonly @enum {string} */
export const MediaDeliveryEventType = Object.freeze({
  STREAMING_STARTED: "media-delivery.streaming_started",
  STREAMING_PAUSED: "media-delivery.streaming_paused",
  STREAMING_RESUMED: "media-delivery.streaming_resumed",
  STREAMING_SEEKED: "media-delivery.streaming_seeked",
  STREAMING_COMPLETED: "media-delivery.streaming_completed",
  STREAMING_FAILED: "media-delivery.streaming_failed",
  CHUNK_DELIVERED: "media-delivery.chunk_delivered",
  BUFFER_UPDATED: "media-delivery.buffer_updated",
  TRANSFER_STARTED: "media-delivery.transfer_started",
  TRANSFER_PROGRESS: "media-delivery.transfer_progress",
  TRANSFER_COMPLETED: "media-delivery.transfer_completed",
  TRANSFER_RESUMED: "media-delivery.transfer_resumed",
  THUMBNAIL_GENERATED: "media-delivery.thumbnail_generated",
  PREVIEW_GENERATED: "media-delivery.preview_generated",
  PREVIEW_FAILED: "media-delivery.preview_failed",
  MEDIA_SYNCHRONIZED: "media-delivery.media_synchronized",
  MEDIA_AVAILABLE: "media-delivery.media_available",
  OFFLINE_MEDIA_QUEUED: "media-delivery.offline_media_queued",
  TRANSFER_OPTIMIZED: "media-delivery.transfer_optimized",
});

/** Machine-readable failure/validation reasons. */
export const DeliveryFailureReason = Object.freeze({
  UNKNOWN_MEDIA: "unknown-media",
  UNKNOWN_SESSION: "unknown-session",
  UNKNOWN_TRANSFER: "unknown-transfer",
  STREAMING_FAILURE: "streaming-failure",
  SYNC_FAILURE: "sync-failure",
  CORRUPTED_PREVIEW: "corrupted-preview",
  CORRUPTED_THUMBNAIL: "corrupted-thumbnail",
  INTEGRITY_FAILURE: "integrity-failure",
  UNAUTHORIZED: "unauthorized",
  INVALID_RANGE: "invalid-range",
  INVALID_TRANSITION: "invalid-transition",
  MALFORMED_METADATA: "malformed-metadata",
  NOT_AVAILABLE: "not-available",
  INTERNAL_ERROR: "internal-error",
});

// === constants ============================================================

export const MEDIA_DELIVERY_FRAMEWORK = "media-delivery";
export const MEDIA_DELIVERY_SCHEMA_VERSION = 1;

/** Default logical chunk size (bytes) over the ciphertext — a Layer-8-compatible fragment size. */
export const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KB
/** Default streaming buffer window (chunks buffered ahead of the cursor). */
export const DEFAULT_BUFFER_CHUNKS = 8;
/** Default progressive transfer window (max chunks in flight). */
export const DEFAULT_TRANSFER_WINDOW = 8;
/** Default number of parallel transfers the optimizer runs. */
export const DEFAULT_PARALLEL_TRANSFERS = 4;
/** Default ciphertext cache TTL (ms) for a source held during a session. */
export const DEFAULT_SOURCE_CACHE_TTL_MS = 60_000;
/** Default preview cache TTL (ms). */
export const DEFAULT_PREVIEW_CACHE_TTL_MS = 300_000;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {object} StreamingSession A streaming session over one media object.
 * @property {string} sessionId @property {string} mediaId @property {string} deviceId @property {string} ownerId
 * @property {string} state one of {@link StreamingState} @property {number} chunkSize @property {number} chunkCount
 * @property {number} cursor current chunk index @property {number} buffered highest contiguous buffered chunk
 * @property {number[]} bufferWindow chunk indices in the buffer @property {number} totalBytes
 * @property {object} metadata @property {string} createdAt @property {string} updatedAt @property {number} version
 */

/**
 * @typedef {object} DeliveryTransfer A progressive download/upload.
 * @property {string} transferId @property {string} mediaId @property {string} direction one of {@link TransferDirection}
 * @property {string} deviceId @property {string} state one of {@link TransferState} @property {string} priority
 * @property {number} chunkSize @property {number} chunkCount @property {number} deliveredChunks
 * @property {number[]} received received chunk indices @property {number} bytesTotal @property {number} bytesTransferred
 * @property {number} window @property {string} createdAt @property {string} updatedAt
 */

/**
 * @typedef {object} MediaPreview A preview/thumbnail record (metadata; generation is async + pluggable).
 * @property {string} previewId @property {string} mediaId @property {string} kind one of {@link PreviewKind}
 * @property {string} state one of {@link PreviewState} @property {number} version @property {object} metadata
 * width/height/format/size/previewMediaId @property {object[]} history @property {string} createdAt @property {string} updatedAt
 */

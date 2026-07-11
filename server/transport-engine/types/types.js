/**
 * @module transport-engine/types
 *
 * Enums + constants for the **Large Payload Transport Engine** — Layer 8, Sprint 2. This subsystem
 * sits ON TOP of the Sprint 1 Reliable Messaging Engine ({@link module:data-plane}). It fragments a
 * large ALREADY-ENCRYPTED payload into chunks, schedules their transmission under application-level
 * flow control + backpressure, multiplexes many concurrent transfers, and reassembles + validates the
 * payload on the receiver — while remaining transport-INDEPENDENT.
 *
 * @security The transport engine carries **opaque ciphertext ONLY**. A payload arrives ALREADY
 * ENCRYPTED (Layers 2–5); the engine slices the ciphertext into fragments, and NEVER encrypts,
 * decrypts, or inspects the plaintext. There is no plaintext or key field on a transfer, chunk, wire
 * envelope, event, or DTO. Chunk checksums are integrity hashes over the ciphertext bytes — not keys.
 *
 * @evolution Reuses the Layer-7 Active Connections via an INJECTED transport (`send(envelope)`), so
 * WebRTC / QUIC / TCP / relay all reuse this subsystem. It transports LARGE FILES, images, videos,
 * voice notes, documents, and binary payloads. It does NOT implement voice calls, video calls, live
 * streaming, or media codecs — those are Layer 11. The `stream` metadata slot is the inert seam a
 * future media sprint fills.
 */

/**
 * A transfer's lifecycle state (a validated FSM — see {@link module:transport-engine/lifecycle}).
 * @readonly @enum {string}
 */
export const TransferState = Object.freeze({
  CREATED: "created", // transfer object built
  FRAGMENTING: "fragmenting", // payload being split into chunks
  ACTIVE: "active", // chunks in flight
  PAUSED: "paused", // transmission paused (manual or backpressure)
  REASSEMBLING: "reassembling", // receiver collecting chunks
  COMPLETED: "completed", // all chunks delivered + payload reconstructed (terminal, success)
  FAILED: "failed", // unrecoverable (retries exhausted / corruption) (terminal)
  CANCELLED: "cancelled", // cancelled by a peer (terminal)
  EXPIRED: "expired", // outlived its TTL (terminal)
  DESTROYED: "destroyed", // record purged (terminal)
});

export const ALL_TRANSFER_STATES = Object.freeze(Object.values(TransferState));

/** Transfer states in which work is still ongoing. */
export const ACTIVE_TRANSFER_STATES = Object.freeze([
  TransferState.CREATED,
  TransferState.FRAGMENTING,
  TransferState.ACTIVE,
  TransferState.PAUSED,
  TransferState.REASSEMBLING,
]);

/** Terminal transfer states. */
export const TERMINAL_TRANSFER_STATES = Object.freeze([
  TransferState.COMPLETED,
  TransferState.FAILED,
  TransferState.CANCELLED,
  TransferState.EXPIRED,
  TransferState.DESTROYED,
]);

export function isTerminalTransferState(s) {
  return TERMINAL_TRANSFER_STATES.includes(s);
}
export function isActiveTransferState(s) {
  return ACTIVE_TRANSFER_STATES.includes(s);
}

/**
 * A chunk's lifecycle state. Sender-side: PENDING → SCHEDULED → SENT → ACKED (or FAILED). Receiver-
 * side chunks are tracked as RECEIVED.
 * @readonly @enum {string}
 */
export const ChunkState = Object.freeze({
  PENDING: "pending", // created, not yet scheduled
  SCHEDULED: "scheduled", // picked by the scheduler, awaiting a send slot (window)
  SENT: "sent", // transmitted; awaiting a chunk-ACK
  ACKED: "acked", // acknowledged by the receiver (terminal, success)
  RECEIVED: "received", // receiver stored it (receiver-side terminal)
  FAILED: "failed", // retransmission exhausted (terminal)
});

export const ALL_CHUNK_STATES = Object.freeze(Object.values(ChunkState));

/** The direction of a transfer relative to this device. */
export const TransferDirection = Object.freeze({ OUTBOUND: "outbound", INBOUND: "inbound" });

/** The kind of wire envelope crossing the transport. */
export const TransportWireType = Object.freeze({
  CHUNK: "chunk", // a payload fragment (opaque ciphertext)
  CHUNK_ACK: "chunk-ack", // acknowledgement of one or more chunks (+ receiver window)
  CONTROL: "transfer-control", // pause / resume / cancel / complete / window-update signal
});

/** Chunk-ACK kinds. */
export const ChunkAckKind = Object.freeze({
  ACK: "ack", // normal acknowledgement
  DUPLICATE: "duplicate-ack", // re-ACK of an already-received chunk
  WINDOW_UPDATE: "window-update", // advertise a new receiver window (backpressure release)
});

/** Transfer-control signals. */
export const TransferControl = Object.freeze({
  PAUSE: "pause",
  RESUME: "resume",
  CANCEL: "cancel",
  COMPLETE: "complete",
});

/**
 * How a received chunk was classified.
 * @readonly @enum {string}
 */
export const ChunkReceiveOutcome = Object.freeze({
  ACCEPTED: "accepted", // new, stored
  DUPLICATE: "duplicate", // already had it → re-ACKed, not re-stored
  INVALID: "invalid", // failed validation (checksum / metadata)
  COMPLETED: "completed", // this chunk completed the transfer
});

/**
 * Configurable transfer priorities (Step 9). Higher weight schedules first; aging prevents starvation.
 * @readonly @enum {string}
 */
export const TransferPriority = Object.freeze({
  CONTROL: "control", // critical control messages
  CHAT: "chat", // interactive chat payloads
  IMAGE: "image", // images / thumbnails
  VOICE_NOTE: "voice-note", // recorded voice notes (NOT live calls)
  DOCUMENT: "document", // documents
  FILE: "file", // large files
  BACKGROUND: "background", // background sync
});

export const ALL_PRIORITIES = Object.freeze(Object.values(TransferPriority));

/** Numeric scheduling weight per priority (higher = scheduled sooner). */
export const PRIORITY_WEIGHT = Object.freeze({
  [TransferPriority.CONTROL]: 100,
  [TransferPriority.CHAT]: 50,
  [TransferPriority.IMAGE]: 30,
  [TransferPriority.VOICE_NOTE]: 25,
  [TransferPriority.DOCUMENT]: 20,
  [TransferPriority.FILE]: 10,
  [TransferPriority.BACKGROUND]: 1,
});

/**
 * The KIND of payload being transported (metadata only — the engine treats every payload as opaque
 * bytes; this drives priority defaults + UI, not codecs). NO live media here (Layer 11).
 * @readonly @enum {string}
 */
export const PayloadKind = Object.freeze({
  FILE: "file",
  IMAGE: "image",
  VIDEO: "video", // a video FILE (not a live call/stream)
  VOICE_NOTE: "voice-note", // a recorded voice note (not a live call)
  DOCUMENT: "document",
  BINARY: "binary",
});

export const ALL_PAYLOAD_KINDS = Object.freeze(Object.values(PayloadKind));

/** Backpressure posture advertised by a receiver / observed by a sender. */
export const BackpressureState = Object.freeze({
  OK: "ok", // flowing normally
  SLOW: "slow", // receiver is slow / buffers filling → reduced window
  PAUSED: "paused", // receiver window is 0 → sender must stop
});

/**
 * Transport-engine event types. A FUTURE Layer 11 (media) consumes these.
 * @readonly @enum {string}
 */
export const TransportEventType = Object.freeze({
  TRANSFER_STARTED: "transport.transfer_started",
  TRANSFER_FRAGMENTED: "transport.transfer_fragmented",
  CHUNK_CREATED: "transport.chunk_created",
  CHUNK_SCHEDULED: "transport.chunk_scheduled",
  CHUNK_SENT: "transport.chunk_sent",
  CHUNK_RECEIVED: "transport.chunk_received",
  CHUNK_ACKED: "transport.chunk_acked",
  CHUNK_RETRIED: "transport.chunk_retried",
  CHUNK_FAILED: "transport.chunk_failed",
  TRANSFER_PROGRESS: "transport.transfer_progress",
  TRANSFER_PAUSED: "transport.transfer_paused",
  TRANSFER_RESUMED: "transport.transfer_resumed",
  TRANSFER_COMPLETED: "transport.transfer_completed",
  TRANSFER_FAILED: "transport.transfer_failed",
  TRANSFER_CANCELLED: "transport.transfer_cancelled",
  TRANSFER_EXPIRED: "transport.transfer_expired",
  WINDOW_UPDATED: "transport.window_updated",
  BACKPRESSURE_APPLIED: "transport.backpressure_applied",
  BACKPRESSURE_RELEASED: "transport.backpressure_released",
});

/** Machine-readable failure reasons. */
export const TransferFailureReason = Object.freeze({
  RETRY_EXHAUSTED: "retry-exhausted",
  CORRUPTED: "corrupted",
  MISSING_CHUNKS: "missing-chunks",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  BACKPRESSURE_TIMEOUT: "backpressure-timeout",
  PAYLOAD_TOO_LARGE: "payload-too-large",
  MALFORMED_METADATA: "malformed-metadata",
  INTERNAL: "internal-error",
});

// === constants ============================================================

export const TRANSPORT_FRAMEWORK = "transport-engine";
export const TRANSPORT_SCHEMA_VERSION = 1;
export const TRANSPORT_PROTOCOL_VERSION = "1.0";

/** Default fragment size (bytes). 64 KiB balances overhead vs. memory. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
/** Minimum + maximum permitted chunk size (bytes). */
export const MIN_CHUNK_SIZE = 1024; // 1 KiB
export const MAX_CHUNK_SIZE = 1024 * 1024; // 1 MiB

/** Hard cap on a single payload (bytes) — memory protection. 2 GiB. */
export const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024 * 1024;

/** Default sliding-window size (max outstanding un-ACKed chunks per transfer). */
export const DEFAULT_WINDOW_SIZE = 8;
export const MIN_WINDOW_SIZE = 1;
export const MAX_WINDOW_SIZE = 256;

/** Default advertised receiver window (chunks the receiver will buffer). */
export const DEFAULT_RECEIVER_WINDOW = 32;

/** Max concurrent transfers a single engine will actively schedule. */
export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 16;

/** Backpressure: max chunks queued per transfer + max buffered bytes on a receiver. */
export const DEFAULT_MAX_QUEUE_DEPTH = 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024; // 128 MiB

/** Chunk ACK timeout (ms) before a sent chunk is retransmitted. */
export const DEFAULT_CHUNK_ACK_TIMEOUT_MS = 4_000;
/** Max retransmissions of a single chunk before the transfer FAILS. */
export const DEFAULT_MAX_CHUNK_RETRIES = 6;

/** Default transfer TTL (ms) before an incomplete transfer expires. */
export const DEFAULT_TRANSFER_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Aging threshold (ms): a ready chunk waiting longer than this gets a scheduling boost. */
export const DEFAULT_STARVATION_AGE_MS = 5_000;

/**
 * @typedef {object} Transfer A large-payload transfer. Carries METADATA only — chunk bytes live in
 * the chunk store.
 * @property {string} transferId @property {string} conversationId
 * @property {string} senderDeviceId @property {string} receiverDeviceId
 * @property {string} direction one of {@link TransferDirection}
 * @property {string} state one of {@link TransferState}
 * @property {string} priority one of {@link TransferPriority}
 * @property {object} payloadMeta `{ kind, name?, mimeType?, totalSize, totalChunks, chunkSize, checksum? }` — NO plaintext
 * @property {number} chunksAcked @property {number} chunksReceived
 * @property {number} bytesTransferred
 * @property {object} stream FUTURE media seam (inert) @property {object} auditMetadata
 * @property {string} createdAt @property {string} updatedAt @property {string} expiresAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} Chunk A single payload fragment. `data` is OPAQUE ciphertext (base64).
 * @property {string} chunkId @property {string} transferId @property {string} conversationId
 * @property {number} index @property {number} total @property {number} size @property {number} offset
 * @property {string} data base64 of the opaque ciphertext fragment @property {string} checksum integrity hash of the fragment bytes
 * @property {string} state one of {@link ChunkState} @property {number} retryCount
 * @property {string|null} nextRetryAt @property {string} priority
 */

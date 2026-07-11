/**
 * @module data-plane/types
 *
 * Enums + constants for the **Reliable P2P Messaging Engine** — Layer 8, Sprint 1. This is the DATA
 * PLANE: it transports ALREADY-ENCRYPTED application messages across the Active Connections that
 * Layer 7 established, with guaranteed-delivery semantics — reliable delivery, ordering, ACKs,
 * retransmission, and duplicate detection.
 *
 * @security The data plane carries **opaque ciphertext ONLY**. It NEVER encrypts, decrypts, or
 * inspects a message payload; the cryptographic layer (Layers 2–5) already produced the ciphertext.
 * There is **no plaintext, and no private/session/message/chain key** anywhere in a transport record,
 * wire envelope, ACK, event, or DTO. See {@link module:data-plane/validators} for the no-plaintext /
 * no-secret invariant.
 *
 * @evolution Transport-INDEPENDENT: the engine sends via an INJECTED transport (`send(envelope)`), so
 * it reuses any Layer-7 connection — WebRTC, QUIC, relay, TCP. It does NOT implement file transfer,
 * chunking, fragmentation, streaming, or media (Sprint 2). The `fragment` metadata slot on a message
 * is the inert extension point Sprint 2 fills.
 */

/**
 * A message's delivery lifecycle state (sender-centric). A validated FSM (see
 * {@link module:data-plane/lifecycle}).
 * @readonly @enum {string}
 */
export const DeliveryState = Object.freeze({
  CREATED: "created", // built, not yet queued
  QUEUED: "queued", // in the send queue awaiting a live connection
  SENDING: "sending", // being handed to the transport
  SENT: "sent", // transmitted; awaiting an ACK
  DELIVERED: "delivered", // the peer's engine reported receipt (pre-ACK confirmation)
  ACKNOWLEDGED: "acknowledged", // ACK received — guaranteed delivered (terminal, success)
  FAILED: "failed", // retransmission exhausted (terminal)
  EXPIRED: "expired", // outlived its TTL before delivery (terminal)
  CANCELLED: "cancelled", // cancelled by the sender before delivery (terminal)
  DESTROYED: "destroyed", // record purged (terminal)
});

/** All delivery states, canonical order. */
export const ALL_DELIVERY_STATES = Object.freeze(Object.values(DeliveryState));

/** States in which a message is still in flight / trackable. */
export const ACTIVE_DELIVERY_STATES = Object.freeze([
  DeliveryState.CREATED,
  DeliveryState.QUEUED,
  DeliveryState.SENDING,
  DeliveryState.SENT,
  DeliveryState.DELIVERED,
]);

/** Terminal delivery states. */
export const TERMINAL_DELIVERY_STATES = Object.freeze([
  DeliveryState.ACKNOWLEDGED,
  DeliveryState.FAILED,
  DeliveryState.EXPIRED,
  DeliveryState.CANCELLED,
  DeliveryState.DESTROYED,
]);

/** States that count as a successful, guaranteed delivery. */
export const DELIVERED_STATES = Object.freeze([DeliveryState.DELIVERED, DeliveryState.ACKNOWLEDGED]);

/** Whether a state is terminal. @param {string} s @returns {boolean} */
export function isTerminalDeliveryState(s) {
  return TERMINAL_DELIVERY_STATES.includes(s);
}

/** Whether a state is still in flight. @param {string} s @returns {boolean} */
export function isActiveDeliveryState(s) {
  return ACTIVE_DELIVERY_STATES.includes(s);
}

/** Message priority — drives send-queue ordering. Higher priority sends first. */
export const MessagePriority = Object.freeze({ HIGH: "high", NORMAL: "normal", LOW: "low" });

/** Numeric weight for a priority (higher = sooner). */
export const PRIORITY_WEIGHT = Object.freeze({ [MessagePriority.HIGH]: 2, [MessagePriority.NORMAL]: 1, [MessagePriority.LOW]: 0 });

/** All priorities. */
export const ALL_PRIORITIES = Object.freeze(Object.values(MessagePriority));

/** The kind of wire envelope crossing the transport. */
export const WireType = Object.freeze({
  DATA: "data", // an application message (opaque ciphertext)
  ACK: "ack", // an acknowledgement
});

/** ACK kinds. */
export const AckType = Object.freeze({
  ACK: "ack", // a normal acknowledgement of receipt
  DUPLICATE_ACK: "duplicate-ack", // re-ACK of an already-received (duplicate) message
  DELAYED_ACK: "delayed-ack", // a batched/delayed acknowledgement
});

/** How an inbound message was classified by ordering/dedup. */
export const ReceiveOutcome = Object.freeze({
  DELIVERED: "delivered", // in-order, new → delivered to the app
  BUFFERED: "buffered", // out-of-order (future seq) → held in the reorder buffer
  DUPLICATE: "duplicate", // already seen → re-ACKed, not re-delivered
  GAP: "gap", // a gap was detected (missing earlier seq)
});

/**
 * Data-plane event types. Sprint 2 (fragmentation/flow-control) subscribes to these.
 * @readonly @enum {string}
 */
export const MessagingEventType = Object.freeze({
  MESSAGE_QUEUED: "dataplane.message_queued",
  MESSAGE_SENDING: "dataplane.message_sending",
  MESSAGE_SENT: "dataplane.message_sent",
  MESSAGE_DELIVERED: "dataplane.message_delivered", // inbound → handed to the app (in order)
  MESSAGE_ACKNOWLEDGED: "dataplane.message_acknowledged", // outbound → ACK received
  ACK_RECEIVED: "dataplane.ack_received",
  ACK_SENT: "dataplane.ack_sent",
  DUPLICATE_DETECTED: "dataplane.duplicate_detected",
  RETRY_SCHEDULED: "dataplane.retry_scheduled",
  RETRY_SUCCEEDED: "dataplane.retry_succeeded",
  RETRY_FAILED: "dataplane.retry_failed",
  MESSAGE_FAILED: "dataplane.message_failed",
  MESSAGE_EXPIRED: "dataplane.message_expired",
  ORDERING_GAP_DETECTED: "dataplane.ordering_gap_detected",
  ORDERING_RECOVERED: "dataplane.ordering_recovered",
  CACHE_INVALIDATED: "dataplane.cache_invalidated",
});

/** Machine-readable failure/validation reasons. */
export const MessagingFailureReason = Object.freeze({
  DUPLICATE_MESSAGE: "duplicate-message",
  MISSING_ACK: "missing-ack",
  INVALID_ORDERING: "invalid-ordering",
  EXPIRED_MESSAGE: "expired-message",
  UNAUTHORIZED_SENDER: "unauthorized-sender",
  MALFORMED_PAYLOAD: "malformed-payload",
  RETRY_EXHAUSTED: "retry-exhausted",
  NO_CONNECTION: "no-connection",
  TRANSPORT_ERROR: "transport-error",
  INTERNAL_ERROR: "internal-error",
});

/** The subsystem identifier + schema/protocol version. */
export const DATAPLANE_FRAMEWORK = "data-plane";
export const DATAPLANE_SCHEMA_VERSION = 1;
export const MESSAGING_PROTOCOL_VERSION = "1.0";

/** Default message TTL (ms) before an undelivered message expires. */
export const DEFAULT_MESSAGE_TTL_MS = 86_400_000; // 24h — chat messages should deliver eventually

/** Default ACK timeout (ms): if no ACK arrives in this long, the message is retransmitted. */
export const DEFAULT_ACK_TIMEOUT_MS = 3_000;

/** Default maximum retransmission attempts before a message FAILS. */
export const DEFAULT_MAX_RETRIES = 8;

/** Default retransmission backoff base (ms). */
export const DEFAULT_RETRY_BASE_MS = 500;

/** Default retransmission backoff cap (ms). */
export const DEFAULT_RETRY_MAX_MS = 30_000;

/** Default retransmission backoff factor. */
export const DEFAULT_RETRY_FACTOR = 2;

/** Default seen-message cache size (per conversation) for duplicate detection. */
export const DEFAULT_DEDUPE_CACHE_SIZE = 4_096;

/** Default reorder-buffer cap (per conversation) before the oldest gap is force-delivered. */
export const DEFAULT_REORDER_BUFFER_LIMIT = 512;

/** Default delivery-status cache TTL (ms). */
export const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * @typedef {object} Message A transported application message. Carries OPAQUE CIPHERTEXT only.
 * @property {string} messageId @property {string} conversationId
 * @property {string} senderDeviceId @property {string} receiverDeviceId
 * @property {object} encryptedPayload the ciphertext envelope from the crypto layer (opaque; no plaintext)
 * @property {number} sequenceNumber per-conversation monotonic sequence
 * @property {string} timestamp ISO @property {string} priority one of {@link MessagePriority}
 * @property {string} state one of {@link DeliveryState} @property {number} retryCount
 * @property {string|null} connectionId the Layer-7 connection it uses @property {object} fragment FUTURE placeholder (Sprint 2)
 * @property {object} transportMetadata @property {object} auditMetadata
 * @property {string|null} sentAt @property {string|null} ackedAt @property {string} expiresAt @property {string|null} nextRetryAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} WireEnvelope What crosses the transport. Ciphertext + routing metadata only.
 * @property {string} type one of {@link WireType} @property {string} protocol
 * @property {string} messageId @property {string} conversationId
 * @property {string} sender @property {string} receiver @property {number} [seq]
 * @property {object} [payload] the opaque ciphertext (DATA only) @property {object} [ack] the ACK block (ACK only)
 * @property {string} ts ISO
 */

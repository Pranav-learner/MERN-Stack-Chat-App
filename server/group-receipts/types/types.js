/**
 * @module group-receipts/types
 *
 * Enums + constants for the **Group Delivery Intelligence & Receipt Aggregation** subsystem — Layer 10,
 * Sprint 4. It sits ON TOP of the frozen Group Communication platform (Sprints 1–3) as an INDEPENDENT
 * subsystem: it tracks per-member delivery + read state, aggregates them INCREMENTALLY into a group
 * receipt, and computes WhatsApp-style delivery indicators (✓ / ✓✓ / ✓✓-blue) — without touching the
 * messaging, fan-out, or synchronization architecture.
 *
 * @security This subsystem reasons over DELIVERY CONTROL-PLANE metadata ONLY — message ids, member ids,
 * device ids, delivery/read states, timestamps, and numeric aggregates. It NEVER handles message
 * plaintext, ciphertext, or key material. It consumes the Sprint-2 delivery-leg events + the Sprint-3
 * frozen seams; the encrypted content is transported + tracked elsewhere.
 *
 * @performance The core design guarantee: **receipt computation is O(1)**. Every per-member transition
 * updates INCREMENTAL counters on a single aggregate record, so a receipt query never scans the member
 * set. Only explicit LIST queries (readers / pending / offline) are O(applicable), which is inherent to
 * returning a list.
 *
 * @evolution Configurable receipt POLICY (member exclusions, read-receipts-disabled, per-member privacy
 * hooks) is the seam for future privacy rules + business rules WITHOUT redesigning the architecture.
 */

// === per-member delivery ==================================================

/**
 * The delivery status of a message to ONE member (the member-level roll-up across their devices).
 * @readonly @enum {string}
 */
export const DeliveryStatus = Object.freeze({
  PENDING: "pending", // no device has received it yet
  SENT: "sent", // handed to the transport for at least one device
  DELIVERED: "delivered", // at least one of the member's devices confirmed delivery
  EXPIRED: "expired", // the message expired before delivery
  FAILED: "failed", // delivery failed after retries
});

export const ALL_DELIVERY_STATUSES = Object.freeze(Object.values(DeliveryStatus));

/** Allowed member-level delivery transitions. */
export const DELIVERY_TRANSITIONS = Object.freeze({
  [DeliveryStatus.PENDING]: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.EXPIRED, DeliveryStatus.FAILED],
  [DeliveryStatus.SENT]: [DeliveryStatus.DELIVERED, DeliveryStatus.EXPIRED, DeliveryStatus.FAILED],
  [DeliveryStatus.DELIVERED]: [], // terminal (a member, once delivered, stays delivered — read is separate)
  [DeliveryStatus.EXPIRED]: [DeliveryStatus.DELIVERED], // a late delivery can still land
  [DeliveryStatus.FAILED]: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED], // a retry can recover
});

/** Delivery-status rank (higher = more advanced) — used to take the max across a member's devices. */
export const DELIVERY_RANK = Object.freeze({ pending: 0, failed: 1, expired: 1, sent: 2, delivered: 3 });

// === per-member read ======================================================

/** The read status of a message for ONE member (deduplicated across their devices). @readonly @enum {string} */
export const ReadStatus = Object.freeze({ UNREAD: "unread", READ: "read" });
export const ALL_READ_STATUSES = Object.freeze(Object.values(ReadStatus));

// === WhatsApp receipt indicators ==========================================

/**
 * The aggregate receipt indicator for a group message (WhatsApp-style). @readonly @enum {string}
 */
export const ReceiptTick = Object.freeze({
  SINGLE: "single", // ✓  — exists, NOT yet delivered to every applicable member
  GREY_DOUBLE: "grey-double", // ✓✓ — delivered to every applicable member (not all read)
  BLUE_DOUBLE: "blue-double", // ✓✓ (blue) — read by every applicable member
});

export const ALL_TICKS = Object.freeze(Object.values(ReceiptTick));

/** Why a member is excluded from a message's applicable set (configurable receipt policy). */
export const ExclusionReason = Object.freeze({
  SENDER: "sender", // the sender never counts toward their own receipt
  LEFT: "left", // the member left before the message
  NOT_MEMBER: "not-member", // not an active member at send time
  READ_RECEIPTS_OFF: "read-receipts-off", // excluded from READ counting only (privacy)
  BUSINESS_RULE: "business-rule", // a future business/privacy rule excluded them
});

// === default receipt policy ===============================================

/**
 * The default, CONFIGURABLE receipt policy. A deployment / group / message may override it. This is the
 * seam for future privacy + business rules WITHOUT architecture changes.
 */
export const DEFAULT_RECEIPT_POLICY = Object.freeze({
  excludeSender: true, // the sender is never in the applicable set
  readReceiptsEnabled: true, // false → blue tick is never shown (stays grey after full delivery)
  requireAllDelivered: true, // grey requires EVERY applicable member delivered
  requireAllRead: true, // blue requires EVERY read-applicable member read
  trackDeviceMetadata: true, // record per-device delivery metadata
});

// === events ===============================================================

/** Group-receipt event types (future dashboards / analytics consume these). @readonly @enum {string} */
export const ReceiptEventType = Object.freeze({
  MESSAGE_REGISTERED: "group-receipts.message_registered",
  MEMBER_DELIVERED: "group-receipts.member_delivered",
  MEMBER_READ: "group-receipts.member_read",
  RECEIPT_UPDATED: "group-receipts.receipt_updated",
  AGGREGATION_UPDATED: "group-receipts.aggregation_updated",
  DELIVERY_COMPLETED: "group-receipts.delivery_completed",
  GROUP_FULLY_DELIVERED: "group-receipts.group_fully_delivered",
  GROUP_FULLY_READ: "group-receipts.group_fully_read",
  ANALYTICS_UPDATED: "group-receipts.analytics_updated",
});

/** Machine-readable failure/validation reasons. */
export const ReceiptFailureReason = Object.freeze({
  UNKNOWN_MESSAGE: "unknown-message",
  UNKNOWN_MEMBER: "unknown-member",
  DUPLICATE_DELIVERY: "duplicate-delivery",
  DUPLICATE_READ: "duplicate-read",
  INVALID_AGGREGATE: "invalid-aggregate",
  INVALID_TRANSITION: "invalid-transition",
  UNAUTHORIZED: "unauthorized",
  REPLAY_DETECTED: "replay-detected",
  MALFORMED_METADATA: "malformed-metadata",
  PRIVACY_VIOLATION: "privacy-violation",
  NOT_APPLICABLE: "not-applicable",
  INTERNAL_ERROR: "internal-error",
});

// === constants ============================================================

export const GROUP_RECEIPTS_FRAMEWORK = "group-receipts";
export const GROUP_RECEIPTS_SCHEMA_VERSION = 1;

/** Default receipt-cache TTL (ms) + size. */
export const DEFAULT_CACHE_TTL_MS = 30_000;
export const DEFAULT_CACHE_MAX = 10_000;

/** Max per-member delivery/read history entries retained (bounded). */
export const MAX_MEMBER_HISTORY = 50;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} MemberReceipt Per-(message, member) delivery + read state. Metadata only.
 * @property {string} messageId @property {string} groupId @property {string} memberId
 * @property {string} deliveryStatus one of {@link DeliveryStatus} (member-level roll-up)
 * @property {boolean} memberDelivered any device delivered @property {boolean} memberRead any device read (deduped)
 * @property {Object<string, object>} devices deviceId → { status, deliveredAt, read, readAt, retries, meta }
 * @property {string|null} firstDeliveredAt @property {string|null} firstReadAt @property {string} sentAt
 * @property {number|null} deliveryLatencyMs @property {number|null} readLatencyMs
 * @property {object[]} history bounded @property {number} version @property {string} updatedAt
 */

/**
 * @typedef {object} ReceiptAggregate Incremental per-message aggregate. O(1) to read.
 * @property {string} messageId @property {string} groupId @property {string} senderId
 * @property {number} applicableCount members that must receive it @property {number} readApplicableCount members counted for READ
 * @property {number} deliveredCount @property {number} readCount @property {number} failedCount
 * @property {string[]} applicableMembers snapshot @property {string} tick one of {@link ReceiptTick}
 * @property {number} deliveryLatencySumMs @property {number} deliveryLatencyCount
 * @property {number} readLatencySumMs @property {number} readLatencyCount
 * @property {string|null} fullyDeliveredAt @property {string|null} fullyReadAt
 * @property {object} policy @property {string} sentAt @property {number} version @property {string} updatedAt
 */

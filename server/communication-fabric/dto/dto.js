/**
 * @module communication-fabric/dto
 *
 * Data-transfer normalization for the **Communication Fabric**. The single job here is to turn a loose,
 * caller-supplied {@link CommunicationRequest} into a stable, defaulted, control-plane-only shape the
 * context builder + decision engine can trust — inferring the conversation type, defaulting priority /
 * media type / availability, and coercing recipient lists — WITHOUT validating deeply (that is the
 * validators' job) and WITHOUT ever accepting message bytes.
 *
 * @security `payloadRef` is normalized to an OPAQUE descriptor ({ id, size, hash, chunks }) — any stray
 * content-bearing field is dropped here and hard-rejected by the validators' no-content scan.
 */

import { ConversationType, MediaType, Priority, RecipientAvailability, SyncState, CommunicationType } from "../types/types.js";

const asString = (v) => (v == null ? undefined : String(v));
const asStringArray = (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** Fields allowed on an opaque payload reference — everything else is discarded. */
const PAYLOAD_REF_FIELDS = Object.freeze(["id", "mediaId", "transferId", "size", "hash", "fingerprint", "chunks", "mimeHint"]);

/**
 * Reduce an arbitrary payload descriptor to an OPAQUE reference (no bytes). Returns `null` when nothing
 * safe remains. This is the seam that keeps content out of the control plane.
 */
export function normalizePayloadRef(ref) {
  if (ref == null || typeof ref !== "object") return null;
  const out = {};
  for (const key of PAYLOAD_REF_FIELDS) if (ref[key] !== undefined) out[key] = typeof ref[key] === "number" ? ref[key] : asString(ref[key]);
  return Object.keys(out).length ? out : null;
}

/**
 * Infer the conversation type when the caller did not state it: a `groupId` ⇒ GROUP, SYNCHRONIZATION /
 * self-target ⇒ SELF, a single recipient ⇒ DIRECT, multiple ⇒ BROADCAST.
 */
export function inferConversationType(req) {
  if (req.conversationType) return String(req.conversationType);
  if (req.groupId) return ConversationType.GROUP;
  if (req.type === CommunicationType.SYNCHRONIZATION) return ConversationType.SELF;
  const recipients = asStringArray(req.recipients);
  if (recipients.length > 1) return ConversationType.BROADCAST;
  return ConversationType.DIRECT;
}

/** Coerce an availability hint (string or `{ status }`) into a {@link RecipientAvailability}. */
export function normalizeAvailability(hint) {
  if (hint == null) return { status: RecipientAvailability.UNKNOWN };
  if (typeof hint === "string") return { status: hint };
  return { status: hint.status ?? RecipientAvailability.UNKNOWN, online: hint.online, offline: hint.offline, unknown: hint.unknown, perRecipient: hint.perRecipient };
}

/** Coerce a sync hint into a `{ state }` posture. */
export function normalizeSync(hint) {
  if (hint == null) return { state: SyncState.UNKNOWN };
  if (typeof hint === "string") return { state: hint };
  return { state: hint.state ?? SyncState.UNKNOWN, pendingDeltas: hint.pendingDeltas, replicaId: asString(hint.replicaId) };
}

/**
 * Normalize a raw {@link CommunicationRequest} into the canonical control-plane request the pipeline
 * consumes. Applies defaults + inference; never mutates the input.
 * @param {import("../types/types.js").CommunicationRequest} req
 * @returns {object} the normalized request
 */
export function normalizeCommunicationRequest(req = {}) {
  const recipients = asStringArray(req.recipients);
  return {
    requestId: asString(req.requestId),
    type: asString(req.type),
    senderId: asString(req.senderId),
    recipients,
    conversationId: asString(req.conversationId),
    groupId: asString(req.groupId),
    conversationType: inferConversationType(req),
    mediaType: asString(req.mediaType) ?? MediaType.NONE,
    priority: asString(req.priority) ?? Priority.NORMAL,
    payloadRef: normalizePayloadRef(req.payloadRef),
    availability: normalizeAvailability(req.availability),
    sync: normalizeSync(req.sync),
    security: req.security && typeof req.security === "object" ? { ...req.security } : {},
    metadata: req.metadata && typeof req.metadata === "object" ? { ...req.metadata } : {},
    policyOverrides: req.policyOverrides && typeof req.policyOverrides === "object" ? { ...req.policyOverrides } : {},
  };
}

/** Normalize pagination query params for list endpoints. */
export function normalizePagination({ limit, offset } = {}) {
  const lim = limit == null ? undefined : Math.max(1, Math.min(1000, Number(limit) || 0));
  const off = offset == null ? 0 : Math.max(0, Number(offset) || 0);
  return { limit: lim, offset: off };
}

/**
 * @typedef {ReturnType<typeof normalizeCommunicationRequest>} NormalizedRequest
 */

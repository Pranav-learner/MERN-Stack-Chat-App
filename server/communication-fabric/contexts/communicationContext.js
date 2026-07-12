/**
 * @module communication-fabric/contexts/communicationContext
 *
 * The **Communication Context** — the single immutable value object every downstream stage (policy,
 * decision, strategy, routing, orchestration) reads. It is a COMPLETE snapshot of everything known about
 * one communication request at the moment it enters the Fabric, decomposed into independent sub-contexts:
 *
 * - `conversation` — direct / group / broadcast / self shape + ids
 * - `group`        — group facet (id, member/fanout hints) when a group conversation
 * - `media`        — media facet (type, opaque payload ref) when carrying media
 * - `recipient`    — recipient set + resolved availability (from presence)
 * - `synchronization` — replica/sync posture relevant to the request
 * - `security`     — advisory secure-session posture (session ready?, transport secure?)
 * - `transport`    — transport hints (priority-derived, route candidates seed)
 * - `metadata`     — free-form non-secret request metadata
 * - `execution`    — bookkeeping (requestId, attempt, timestamps)
 * - `diagnostics`  — how the context itself was assembled (which facets were inferred vs supplied)
 *
 * @performance The context is built ONCE per request and then DEEP-FROZEN, so every reader shares one
 * structurally-immutable object — no defensive copying, no accidental mutation across the pipeline.
 *
 * @security Every field is control-plane metadata. The media facet holds an OPAQUE `payloadRef` only; the
 * builder + validators guarantee no plaintext / ciphertext / key material is ever present.
 */

import { ConversationType, MediaType, RecipientAvailability, SyncState } from "../types/types.js";

/** Recursively freeze an object graph so the context is structurally immutable. */
export function deepFreeze(obj) {
  if (obj == null || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  return Object.freeze(obj);
}

/**
 * A frozen wrapper exposing convenience accessors over the raw sub-context bag. Constructing it directly
 * is uncommon — use the {@link ContextBuilder}. The `raw` bag IS the persisted/serialized shape.
 */
export class CommunicationContext {
  /** @param {object} facets the assembled + frozen sub-context bag */
  constructor(facets) {
    this.raw = deepFreeze(facets);
    Object.freeze(this);
  }

  get requestId() {
    return this.raw.execution.requestId;
  }
  get type() {
    return this.raw.type;
  }
  get conversation() {
    return this.raw.conversation;
  }
  get group() {
    return this.raw.group;
  }
  get media() {
    return this.raw.media;
  }
  get recipient() {
    return this.raw.recipient;
  }
  get synchronization() {
    return this.raw.synchronization;
  }
  get security() {
    return this.raw.security;
  }
  get transport() {
    return this.raw.transport;
  }
  get metadata() {
    return this.raw.metadata;
  }
  get execution() {
    return this.raw.execution;
  }
  get diagnostics() {
    return this.raw.diagnostics;
  }

  // === derived predicates (constant time) ===================================

  /** Is this a group conversation? */
  isGroup() {
    return this.raw.conversation.type === ConversationType.GROUP;
  }
  /** Is this a self / multi-device conversation? */
  isSelf() {
    return this.raw.conversation.type === ConversationType.SELF;
  }
  /** Does the request carry media? */
  hasMedia() {
    return this.raw.media.type !== MediaType.NONE;
  }
  /** Are all recipients known to be offline? */
  isOffline() {
    return this.raw.recipient.availability === RecipientAvailability.OFFLINE;
  }
  /** Is the recipient set fully reachable now? */
  isOnline() {
    return this.raw.recipient.availability === RecipientAvailability.ONLINE;
  }
  /** Does the replica need catch-up sync? */
  isDiverged() {
    return this.raw.synchronization.state === SyncState.DIVERGED;
  }

  /** A compact, serializable view (the persisted shape). */
  toJSON() {
    return this.raw;
  }
}

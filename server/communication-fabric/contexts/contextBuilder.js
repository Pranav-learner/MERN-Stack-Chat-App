/**
 * @module communication-fabric/contexts/contextBuilder
 *
 * Assembles a complete, immutable {@link CommunicationContext} from a normalized request. This is STEP 5
 * of the pipeline — "every request should build a complete immutable context". The builder is pure +
 * deterministic: given the same normalized request (and the same injected resolvers), it produces an
 * identical context, which is what makes decision caching + tests reproducible.
 *
 * Optional resolvers let a deployment enrich a facet from a lower layer WITHOUT the Fabric depending on
 * it: `resolveAvailability(recipients)` (Layer 6 presence), `resolveSync(context)` (Layer 9),
 * `resolveSecurity(context)` (Layer 4/5). When a resolver is absent the facet falls back to its
 * conservative default (UNKNOWN), so the Fabric is fully functional standalone.
 *
 * @security The builder copies ONLY control-plane fields into the context; the opaque `payloadRef` is the
 * only payload-adjacent data, and it never contains bytes.
 */

import { CommunicationContext } from "./communicationContext.js";
import { ConversationType, MediaType, RecipientAvailability, SyncState, PRIORITY_RANK } from "../types/types.js";

/**
 * @typedef {object} ContextBuilderDeps
 * @property {() => number} [clock] millisecond clock (default Date.now)
 * @property {(recipients: string[], req: object) => object} [resolveAvailability] presence resolver
 * @property {(req: object) => object} [resolveSync] sync-posture resolver
 * @property {(req: object) => object} [resolveSecurity] secure-session resolver
 */

export class ContextBuilder {
  /** @param {ContextBuilderDeps} [deps] */
  constructor(deps = {}) {
    this.clock = deps.clock ?? (() => Date.now());
    this.resolveAvailability = deps.resolveAvailability ?? null;
    this.resolveSync = deps.resolveSync ?? null;
    this.resolveSecurity = deps.resolveSecurity ?? null;
  }

  /**
   * Build the immutable context for a normalized request.
   * @param {import("../dto/dto.js").NormalizedRequest} req the normalized request
   * @param {object} [opts]
   * @param {number} [opts.attempt] execution attempt number (default 1)
   * @returns {CommunicationContext}
   */
  build(req, opts = {}) {
    const now = this.clock();
    const at = new Date(now).toISOString();
    const inferred = [];

    // --- conversation facet -------------------------------------------------
    const conversation = {
      type: req.conversationType ?? ConversationType.DIRECT,
      conversationId: req.conversationId ?? null,
      groupId: req.groupId ?? null,
      senderId: req.senderId ?? null,
    };
    if (!req.conversationType) inferred.push("conversation.type");

    // --- group facet (only meaningful for group conversations) --------------
    const group =
      conversation.type === ConversationType.GROUP
        ? { groupId: req.groupId ?? null, fanout: true, memberHint: req.metadata?.memberCount ?? null }
        : { groupId: null, fanout: false, memberHint: null };

    // --- media facet --------------------------------------------------------
    const media = {
      type: req.mediaType ?? MediaType.NONE,
      payloadRef: req.payloadRef ?? null,
      size: req.payloadRef?.size ?? null,
    };

    // --- recipient facet (availability from presence, if wired) -------------
    let availability = req.availability ?? { status: RecipientAvailability.UNKNOWN };
    if (this.resolveAvailability) {
      try {
        const resolved = this.resolveAvailability(req.recipients, req);
        if (resolved) availability = typeof resolved === "string" ? { status: resolved } : resolved;
      } catch {
        inferred.push("recipient.availability:resolver-failed");
      }
    } else if (availability.status === RecipientAvailability.UNKNOWN) {
      inferred.push("recipient.availability");
    }
    const recipient = {
      ids: req.recipients ?? [],
      count: (req.recipients ?? []).length,
      availability: availability.status ?? RecipientAvailability.UNKNOWN,
      perRecipient: availability.perRecipient ?? null,
    };

    // --- synchronization facet ---------------------------------------------
    let sync = req.sync ?? { state: SyncState.UNKNOWN };
    if (this.resolveSync) {
      try {
        const resolved = this.resolveSync(req);
        if (resolved) sync = typeof resolved === "string" ? { state: resolved } : resolved;
      } catch {
        inferred.push("synchronization:resolver-failed");
      }
    } else if (sync.state === SyncState.UNKNOWN) {
      inferred.push("synchronization.state");
    }
    const synchronization = { state: sync.state ?? SyncState.UNKNOWN, pendingDeltas: sync.pendingDeltas ?? null, replicaId: sync.replicaId ?? null };

    // --- security facet (advisory; secure-session posture) ------------------
    let security = { sessionReady: req.security?.sessionReady ?? null, transportSecure: req.security?.transportSecure ?? null, mode: req.security?.mode ?? "advisory" };
    if (this.resolveSecurity) {
      try {
        const resolved = this.resolveSecurity(req);
        if (resolved) security = { ...security, ...resolved };
      } catch {
        inferred.push("security:resolver-failed");
      }
    }

    // --- transport facet (priority-derived seed for routing) ----------------
    const transport = {
      priority: req.priority,
      priorityRank: PRIORITY_RANK[req.priority] ?? PRIORITY_RANK.normal,
      preferDirect: recipient.availability === RecipientAvailability.ONLINE,
      routeCandidates: [], // seeded by the route planner in a later stage
    };

    // --- execution + diagnostics bookkeeping --------------------------------
    const execution = { requestId: req.requestId ?? null, attempt: opts.attempt ?? 1, createdAt: at, builtAtMs: now };
    const diagnostics = { inferredFacets: inferred, resolvers: { availability: !!this.resolveAvailability, sync: !!this.resolveSync, security: !!this.resolveSecurity }, builtAt: at };

    return new CommunicationContext({
      type: req.type,
      conversation,
      group,
      media,
      recipient,
      synchronization,
      security,
      transport,
      metadata: req.metadata ?? {},
      execution,
      diagnostics,
    });
  }
}

/** Convenience: build a context in one call. */
export function buildContext(req, deps = {}, opts = {}) {
  return new ContextBuilder(deps).build(req, opts);
}

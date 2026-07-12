/**
 * @module communication-fabric/policies/defaultPolicies
 *
 * The default, CONFIGURABLE policy set (STEP 8). Each policy reads its slice of the engine config bag, so
 * a deployment tunes behaviour without editing code. Every policy is control-plane only: it biases the
 * decision, adds a constraint, or vetoes — it never touches bytes.
 *
 * Config shape (all optional; defaults shown):
 *   {
 *     messaging: { maxRecipients: 512 },
 *     media:     { allowedTypes: null /* null = all *\/, maxSizeBytes: null },
 *     group:     { maxGroupFanout: 100000, requireGroupId: true },
 *     sync:      { attachOnDiverge: true },
 *     security:  { requireSecureSession: false },
 *     priority:  { urgentBiasesDirect: true },
 *   }
 */

import { PolicyKind } from "./policy.js";
import { StrategyType, MediaType, ConversationType, RecipientAvailability, SyncState, Priority } from "../types/types.js";

/** Messaging policy — caps recipient fan-out for a single direct/broadcast send. */
export const messagingPolicy = {
  id: "messaging.recipient-cap",
  kind: PolicyKind.MESSAGING,
  describe: "Caps the number of recipients on a single direct/broadcast send.",
  applies: (ctx) => ctx.conversation.type === ConversationType.DIRECT || ctx.conversation.type === ConversationType.BROADCAST,
  evaluate(ctx, config = {}) {
    const max = config.messaging?.maxRecipients ?? 512;
    if (ctx.recipient.count > max) return { deny: true, note: `recipient count ${ctx.recipient.count} exceeds cap ${max}` };
    return {};
  },
};

/** Media policy — restricts allowed media types + max size; nudges toward the media strategy. */
export const mediaPolicy = {
  id: "media.type-and-size",
  kind: PolicyKind.MEDIA,
  describe: "Restricts allowed media types and maximum media size.",
  applies: (ctx) => ctx.media.type !== MediaType.NONE,
  evaluate(ctx, config = {}) {
    const allowed = config.media?.allowedTypes ?? null; // null = allow all
    const maxSize = config.media?.maxSizeBytes ?? null;
    if (allowed && !allowed.includes(ctx.media.type)) return { deny: true, note: `media type ${ctx.media.type} not permitted` };
    if (maxSize != null && ctx.media.size != null && ctx.media.size > maxSize) return { deny: true, note: `media size ${ctx.media.size} exceeds ${maxSize}` };
    return { bias: { [StrategyType.MEDIA]: 1 }, note: "media permitted" };
  },
};

/** Group policy — requires a group id + caps fan-out size. */
export const groupPolicy = {
  id: "group.fanout-guard",
  kind: PolicyKind.GROUP,
  describe: "Requires a group id and caps group fan-out size.",
  applies: (ctx) => ctx.conversation.type === ConversationType.GROUP,
  evaluate(ctx, config = {}) {
    const requireGroupId = config.group?.requireGroupId ?? true;
    const maxFanout = config.group?.maxGroupFanout ?? 100000;
    if (requireGroupId && !ctx.group.groupId) return { deny: true, note: "group conversation without a groupId" };
    if (ctx.group.memberHint != null && ctx.group.memberHint > maxFanout) return { deny: true, note: `group fanout ${ctx.group.memberHint} exceeds ${maxFanout}` };
    return { bias: { [StrategyType.GROUP]: 1 }, note: "group send permitted" };
  },
};

/** Synchronization policy — attaches a sync step when the replica has diverged. */
export const synchronizationPolicy = {
  id: "sync.attach-on-diverge",
  kind: PolicyKind.SYNCHRONIZATION,
  describe: "Requires an accompanying sync step when the replica has diverged.",
  applies: (ctx) => ctx.synchronization.state === SyncState.DIVERGED,
  evaluate(_ctx, config = {}) {
    if (config.sync?.attachOnDiverge === false) return {};
    return { constraints: { requireSyncStep: true }, note: "replica diverged — sync attached" };
  },
};

/** Security policy — optionally requires a ready secure session before non-local communication. */
export const securityPolicy = {
  id: "security.session-guard",
  kind: PolicyKind.SECURITY,
  describe: "Optionally requires a ready secure session before communicating.",
  applies: (_ctx) => true,
  evaluate(ctx, config = {}) {
    const require = config.security?.requireSecureSession ?? false;
    if (require && ctx.security?.sessionReady === false) return { deny: true, note: "secure session not ready" };
    return {};
  },
};

/** Priority policy — urgent requests bias direct + forbid bulk queuing. */
export const priorityPolicy = {
  id: "priority.urgent-guard",
  kind: PolicyKind.PRIORITY,
  describe: "Urgent requests bias direct delivery and must not queue behind bulk traffic.",
  applies: (ctx) => ctx.transport.priority === Priority.URGENT,
  evaluate(_ctx, config = {}) {
    if (config.priority?.urgentBiasesDirect === false) return { constraints: { noBulkQueue: true } };
    return { bias: { [StrategyType.DIRECT]: 1 }, constraints: { noBulkQueue: true }, note: "urgent" };
  },
};

/** The default, ordered policy list a deployment builds its {@link PolicySet} from. */
export const DEFAULT_POLICIES = Object.freeze([messagingPolicy, mediaPolicy, groupPolicy, synchronizationPolicy, securityPolicy, priorityPolicy]);

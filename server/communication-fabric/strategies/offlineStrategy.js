/**
 * @module communication-fabric/strategies/offlineStrategy
 *
 * **Offline Strategy** — store-and-forward for recipients that are not reachable now. It queues the
 * opaque payload for durable delivery (Layer 8 store-and-forward) and records a sync obligation so the
 * recipient catches up when they reconnect (Layer 9). Selected when recipients are OFFLINE, or as the
 * conservative fallback when availability is UNKNOWN and a durable queue was required by policy/rules.
 *
 * @security A `store` step references the opaque payload + recipients only — the durable queue holds
 * ciphertext managed by Layer 8, never plaintext/keys.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind, ConversationType, MediaType, RecipientAvailability } from "../types/types.js";

export class OfflineStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.OFFLINE });
  }

  supports(ctx) {
    if (ctx.conversation.type === ConversationType.GROUP) return false; // group handles its own offline members
    if (ctx.media.type !== MediaType.NONE) return false; // media pipeline owns its offline path
    return ctx.recipient.availability === RecipientAvailability.OFFLINE || ctx.recipient.availability === RecipientAvailability.PARTIAL || ctx.recipient.availability === RecipientAvailability.UNKNOWN;
  }

  baseScore(ctx) {
    if (ctx.recipient.availability === RecipientAvailability.OFFLINE) return 6;
    if (ctx.recipient.availability === RecipientAvailability.PARTIAL) return 3;
    return 2; // UNKNOWN — a safe candidate, but Direct usually wins when it is a viable candidate too
  }

  describe(_ctx, _opts = {}) {
    return { primaryRoute: RouteKind.STORE_AND_FORWARD, subsystems: [SubsystemKind.MESSAGING, SubsystemKind.SYNCHRONIZATION] };
  }

  plan(ctx, _decision, _opts = {}) {
    const store = makeStep({
      subsystem: SubsystemKind.MESSAGING,
      action: "store",
      route: RouteKind.STORE_AND_FORWARD,
      required: true,
      params: { recipients: ctx.recipient.ids, conversationId: ctx.conversation.conversationId, priority: ctx.transport.priority, payloadRef: ctx.media.payloadRef, durable: true },
    });
    const markSync = makeStep({
      subsystem: SubsystemKind.SYNCHRONIZATION,
      action: "enqueue-delta",
      route: RouteKind.SYNC_CHANNEL,
      required: false,
      dependsOn: [store.stepId],
      params: { conversationId: ctx.conversation.conversationId, recipients: ctx.recipient.ids },
    });
    return [store, markSync];
  }
}

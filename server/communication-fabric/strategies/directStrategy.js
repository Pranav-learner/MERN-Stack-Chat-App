/**
 * @module communication-fabric/strategies/directStrategy
 *
 * **Direct Communication Strategy** — delivers a 1:1 (or small broadcast) message straight over the
 * Layer 8 data plane to reachable recipients. This is the baseline path for online, non-media, non-group
 * conversations. It optionally prepends a sync step when the decision constraints require catch-up.
 *
 * @security Emits a single `deliver` step whose params reference the opaque payload + recipients — no
 * bytes. The actual encrypted delivery runs in the frozen Layer 8 messaging subsystem.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind, ConversationType, MediaType, RecipientAvailability } from "../types/types.js";

export class DirectCommunicationStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.DIRECT });
  }

  supports(ctx) {
    // Direct handles 1:1 / broadcast text where recipients are not fully offline, and there is no media.
    if (ctx.media.type !== MediaType.NONE) return false;
    if (ctx.conversation.type === ConversationType.GROUP) return false;
    if (ctx.conversation.type === ConversationType.SELF) return false;
    return ctx.recipient.availability !== RecipientAvailability.OFFLINE;
  }

  baseScore(ctx) {
    // Strong fit when recipients are online; weaker when availability is unknown/partial.
    if (ctx.recipient.availability === RecipientAvailability.ONLINE) return 6;
    if (ctx.recipient.availability === RecipientAvailability.PARTIAL) return 3;
    return 2;
  }

  describe(ctx, opts = {}) {
    const subsystems = [];
    if (opts.constraints?.requireSyncStep) subsystems.push(SubsystemKind.SYNCHRONIZATION);
    subsystems.push(SubsystemKind.MESSAGING);
    return { primaryRoute: RouteKind.DIRECT_TRANSPORT, subsystems };
  }

  plan(ctx, decision, opts = {}) {
    const steps = [];
    if (opts.constraints?.requireSyncStep || decision.constraints?.requireSyncStep) {
      steps.push(makeStep({ subsystem: SubsystemKind.SYNCHRONIZATION, action: "sync", route: RouteKind.SYNC_CHANNEL, required: false, params: { conversationId: ctx.conversation.conversationId } }));
    }
    steps.push(
      makeStep({
        subsystem: SubsystemKind.MESSAGING,
        action: "deliver",
        route: RouteKind.DIRECT_TRANSPORT,
        required: true,
        dependsOn: steps.map((s) => s.stepId),
        params: { recipients: ctx.recipient.ids, conversationId: ctx.conversation.conversationId, priority: ctx.transport.priority, payloadRef: ctx.media.payloadRef },
      }),
    );
    return steps;
  }
}

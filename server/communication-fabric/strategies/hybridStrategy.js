/**
 * @module communication-fabric/strategies/hybridStrategy
 *
 * **Hybrid Strategy — PLACEHOLDER (Sprint 2).** Declares the composed path (e.g. try direct, fall back to
 * relay/offline; deliver media + fan out + sync in one plan) so the architecture is complete. Sprint 1
 * does NOT run adaptive composition; it is registered but inert (`supports` false unless explicitly
 * forced). When forced, it emits a well-formed multi-subsystem plan so downstream shape validation works.
 *
 * @evolution Sprint 2 turns this into the real composer that blends strategies from live signals + the
 * fallback framework.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind } from "../types/types.js";

export class HybridStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.HYBRID });
  }

  supports(ctx) {
    return ctx.metadata?.forceHybrid === true;
  }

  baseScore(ctx) {
    // Never wins by accident; when explicitly forced it wins decisively (Sprint 2 makes this adaptive).
    return ctx.metadata?.forceHybrid === true ? 100 : 0;
  }

  describe(_ctx, _opts = {}) {
    return { primaryRoute: RouteKind.DIRECT_TRANSPORT, subsystems: [SubsystemKind.MESSAGING, SubsystemKind.SYNCHRONIZATION] };
  }

  plan(ctx, _decision, _opts = {}) {
    const primary = makeStep({ subsystem: SubsystemKind.MESSAGING, action: "deliver", route: RouteKind.DIRECT_TRANSPORT, required: true, params: { recipients: ctx.recipient.ids, placeholder: true } });
    const sync = makeStep({ subsystem: SubsystemKind.SYNCHRONIZATION, action: "sync", route: RouteKind.SYNC_CHANNEL, required: false, dependsOn: [primary.stepId], params: { conversationId: ctx.conversation.conversationId, placeholder: true } });
    return [primary, sync];
  }
}

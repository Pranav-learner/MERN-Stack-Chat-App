/**
 * @module communication-fabric/strategies/synchronizationStrategy
 *
 * **Synchronization Strategy** — routes multi-device state sync (SELF conversations, explicit
 * SYNCHRONIZATION requests) through the Layer 9 offline-sync + replication engine. It computes/pushes a
 * delta plan to the sender's own devices. No recipient delivery — this is the sender's replica set.
 *
 * @security One `sync` step referencing conversation/replica ids + version metadata only — Layer 9 moves
 * no plaintext; the Fabric moves none either.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind, ConversationType, CommunicationType } from "../types/types.js";

export class SynchronizationStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.SYNCHRONIZATION });
  }

  supports(ctx) {
    return ctx.type === CommunicationType.SYNCHRONIZATION || ctx.conversation.type === ConversationType.SELF;
  }

  baseScore(_ctx) {
    return 6;
  }

  describe(_ctx, _opts = {}) {
    return { primaryRoute: RouteKind.SYNC_CHANNEL, subsystems: [SubsystemKind.SYNCHRONIZATION] };
  }

  plan(ctx, _decision, _opts = {}) {
    return [
      makeStep({
        subsystem: SubsystemKind.SYNCHRONIZATION,
        action: "sync",
        route: RouteKind.SYNC_CHANNEL,
        required: true,
        params: { conversationId: ctx.conversation.conversationId, replicaId: ctx.synchronization.replicaId, pendingDeltas: ctx.synchronization.pendingDeltas },
      }),
    ];
  }
}

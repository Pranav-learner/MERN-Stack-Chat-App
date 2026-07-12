/**
 * @module communication-fabric/strategies/relayStrategy
 *
 * **Relay Strategy — PLACEHOLDER (Sprint 2).** Declares the server-relayed path so the pipeline + registry
 * are complete, but Sprint 1 does NOT implement adaptive relay selection (that is Sprint 2: intelligent
 * routing / transport optimization). It is registered but its `supports` returns false unless a request
 * explicitly forces the relay via metadata, so it never wins by accident. Its `plan` produces a minimal,
 * well-formed relayed step so downstream validation + tests can exercise the shape.
 *
 * @evolution Sprint 2 fills in `supports`/`baseScore` with live network-quality + reachability scoring.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind, MediaType, ConversationType } from "../types/types.js";

export class RelayStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.RELAY });
  }

  supports(ctx) {
    // Inert unless explicitly forced — Sprint 1 does not choose relay adaptively.
    return ctx.metadata?.forceRelay === true && ctx.media.type === MediaType.NONE && ctx.conversation.type !== ConversationType.GROUP;
  }

  baseScore(ctx) {
    // Inert by default; when explicitly forced it must win decisively (Sprint 2 replaces this with a
    // live network score). Only reached when `supports` was true — i.e. relay was forced.
    return ctx.metadata?.forceRelay === true ? 100 : 1;
  }

  describe(_ctx, _opts = {}) {
    return { primaryRoute: RouteKind.RELAYED_TRANSPORT, subsystems: [SubsystemKind.CONNECTIVITY, SubsystemKind.MESSAGING] };
  }

  plan(ctx, _decision, _opts = {}) {
    return [
      makeStep({
        subsystem: SubsystemKind.MESSAGING,
        action: "relay-deliver",
        route: RouteKind.RELAYED_TRANSPORT,
        required: true,
        params: { recipients: ctx.recipient.ids, conversationId: ctx.conversation.conversationId, payloadRef: ctx.media.payloadRef, relay: "default", placeholder: true },
      }),
    ];
  }
}

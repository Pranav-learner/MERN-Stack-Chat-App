/**
 * @module communication-fabric/strategies/mediaStrategy
 *
 * **Media Strategy** — routes any media-carrying request (image / video / audio / voice-note / document /
 * binary) through the Layer 11 secure media platform. It composes a media-delivery step with an optional
 * group fan-out (media in a group) and an optional sync step, so a media message is one coherent plan.
 *
 * @security The `media` step references the OPAQUE media id + hash only; the client encrypts device-side
 * and the media pipeline relays ciphertext. The Fabric never sees bytes or the per-file key.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind, ConversationType, MediaType } from "../types/types.js";

export class MediaStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.MEDIA });
  }

  supports(ctx) {
    return ctx.media.type !== MediaType.NONE;
  }

  baseScore(ctx) {
    // Any real media type is a strong media candidate; group media still routes through media first.
    return ctx.media.type === MediaType.NONE ? 0 : 6;
  }

  describe(ctx, _opts = {}) {
    const subsystems = [SubsystemKind.MEDIA];
    if (ctx.conversation.type === ConversationType.GROUP) subsystems.push(SubsystemKind.GROUP);
    else subsystems.push(SubsystemKind.MESSAGING);
    return { primaryRoute: RouteKind.MEDIA_PIPELINE, subsystems };
  }

  plan(ctx, _decision, _opts = {}) {
    const media = makeStep({
      subsystem: SubsystemKind.MEDIA,
      action: "deliver-media",
      route: RouteKind.MEDIA_PIPELINE,
      required: true,
      params: { mediaType: ctx.media.type, payloadRef: ctx.media.payloadRef, conversationId: ctx.conversation.conversationId, groupId: ctx.group.groupId },
    });
    const isGroup = ctx.conversation.type === ConversationType.GROUP;
    const notify = makeStep({
      subsystem: isGroup ? SubsystemKind.GROUP : SubsystemKind.MESSAGING,
      action: isGroup ? "fanout-media-ref" : "deliver-media-ref",
      route: isGroup ? RouteKind.GROUP_FANOUT : RouteKind.DIRECT_TRANSPORT,
      required: true,
      dependsOn: [media.stepId],
      params: { recipients: ctx.recipient.ids, conversationId: ctx.conversation.conversationId, groupId: ctx.group.groupId, mediaRef: ctx.media.payloadRef },
    });
    return [media, notify];
  }
}

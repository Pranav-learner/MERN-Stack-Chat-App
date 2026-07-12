/**
 * @module communication-fabric/strategies/groupStrategy
 *
 * **Group Strategy** — routes a group conversation message through the Layer 10 group communication
 * engine's fan-out, which internally owns per-member delivery, offline members, and rekey. The Fabric
 * simply decides "this is a group send" and delegates one `fanout` step; it never reimplements fan-out.
 * A delivery/receipt step is appended so the Layer 10 receipt subsystem is engaged.
 *
 * @security One `fanout` step referencing the group id + opaque payload ref — no bytes/keys. Group key
 * management + encryption stay entirely inside Layer 10.
 */

import { BaseStrategy, makeStep } from "./strategy.js";
import { StrategyType, SubsystemKind, RouteKind, ConversationType, MediaType } from "../types/types.js";

export class GroupStrategy extends BaseStrategy {
  constructor() {
    super({ type: StrategyType.GROUP });
  }

  supports(ctx) {
    // Group text/control. Group MEDIA is owned by the Media strategy (which then fans out the ref).
    return ctx.conversation.type === ConversationType.GROUP && ctx.media.type === MediaType.NONE;
  }

  baseScore(_ctx) {
    return 6;
  }

  describe(ctx, opts = {}) {
    const subsystems = [];
    if (opts.constraints?.requireSyncStep) subsystems.push(SubsystemKind.SYNCHRONIZATION);
    subsystems.push(SubsystemKind.GROUP, SubsystemKind.DELIVERY);
    return { primaryRoute: RouteKind.GROUP_FANOUT, subsystems };
  }

  plan(ctx, decision, opts = {}) {
    const steps = [];
    if (opts.constraints?.requireSyncStep || decision.constraints?.requireSyncStep) {
      steps.push(makeStep({ subsystem: SubsystemKind.SYNCHRONIZATION, action: "sync", route: RouteKind.SYNC_CHANNEL, required: false, params: { groupId: ctx.group.groupId } }));
    }
    const fanout = makeStep({
      subsystem: SubsystemKind.GROUP,
      action: "fanout",
      route: RouteKind.GROUP_FANOUT,
      required: true,
      dependsOn: steps.map((s) => s.stepId),
      params: { groupId: ctx.group.groupId, senderId: ctx.conversation.senderId, priority: ctx.transport.priority, payloadRef: ctx.media.payloadRef },
    });
    steps.push(fanout);
    steps.push(
      makeStep({
        subsystem: SubsystemKind.DELIVERY,
        action: "register-receipt",
        route: RouteKind.LOCAL,
        required: false,
        dependsOn: [fanout.stepId],
        params: { groupId: ctx.group.groupId },
      }),
    );
    return steps;
  }
}

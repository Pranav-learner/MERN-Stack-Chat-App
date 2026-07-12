/**
 * @module communication-fabric/decision-engine/decisionRules
 *
 * **Pluggable decision rules.** A rule is a small, pure function that inspects the immutable context and
 * contributes to the decision draft — biasing strategy scores and/or recording a human-readable reason.
 * Rules are how the Decision Engine reasons WITHOUT a `switch`/`if` cascade: the engine runs an ordered
 * list of rules, each independently additive, so a deployment can insert, remove, or reorder rules (STEP
 * 4: "decision strategies must be pluggable") without touching the engine.
 *
 * A rule has the shape:
 *   { id, describe, evaluate(context, draft) => { bias?: Record<StrategyType, number>, reason?, constraints? } }
 *
 * - `bias`        — additive score deltas per strategy type (nudges selection).
 * - `reason`      — `{ effect, note }` appended to the decision's ordered reason audit.
 * - `constraints` — merged into the decision's policy-independent constraints.
 *
 * @evolution This is the primary seam Sprint 2 (adaptive routing) extends: network-quality / battery /
 * bandwidth rules drop in here as additional entries, adjusting bias from live signals — no engine change.
 */

import { StrategyType, ConversationType, MediaType, RecipientAvailability, SyncState, Priority, CommunicationType } from "../types/types.js";

/**
 * Rule: media requests bias strongly toward the MEDIA strategy (Layer 11 owns blob delivery).
 */
export const mediaRule = {
  id: "media-affinity",
  describe: "Media-carrying requests prefer the media pipeline.",
  evaluate(ctx) {
    if (ctx.media.type === MediaType.NONE) return {};
    return { bias: { [StrategyType.MEDIA]: 5 }, reason: { effect: "prefer-media", note: `media type ${ctx.media.type}` } };
  },
};

/**
 * Rule: group conversations bias toward the GROUP strategy (Layer 10 fan-out).
 */
export const groupRule = {
  id: "group-affinity",
  describe: "Group conversations prefer group fan-out.",
  evaluate(ctx) {
    if (ctx.conversation.type !== ConversationType.GROUP) return {};
    return { bias: { [StrategyType.GROUP]: 5 }, reason: { effect: "prefer-group", note: `group ${ctx.group.groupId ?? "?"}` } };
  },
};

/**
 * Rule: explicit synchronization requests (or SELF conversations) bias toward SYNCHRONIZATION.
 */
export const syncRule = {
  id: "sync-affinity",
  describe: "Synchronization / self conversations prefer the sync engine.",
  evaluate(ctx) {
    if (ctx.type === CommunicationType.SYNCHRONIZATION || ctx.conversation.type === ConversationType.SELF) {
      return { bias: { [StrategyType.SYNCHRONIZATION]: 5 }, reason: { effect: "prefer-sync", note: "sync/self conversation" } };
    }
    return {};
  },
};

/**
 * Rule: offline recipients bias toward the OFFLINE (store-and-forward) strategy and away from DIRECT.
 */
export const availabilityRule = {
  id: "availability",
  describe: "Offline recipients prefer store-and-forward; online recipients prefer direct.",
  evaluate(ctx) {
    const a = ctx.recipient.availability;
    if (a === RecipientAvailability.OFFLINE) {
      return { bias: { [StrategyType.OFFLINE]: 4, [StrategyType.DIRECT]: -3 }, reason: { effect: "prefer-offline", note: "all recipients offline" } };
    }
    if (a === RecipientAvailability.ONLINE) {
      return { bias: { [StrategyType.DIRECT]: 3 }, reason: { effect: "prefer-direct", note: "recipients online" } };
    }
    if (a === RecipientAvailability.PARTIAL) {
      return { bias: { [StrategyType.OFFLINE]: 1 }, reason: { effect: "mixed-availability", note: "partial reachability" } };
    }
    // UNKNOWN: conservative nudge toward store-and-forward so nothing is dropped.
    return { bias: { [StrategyType.OFFLINE]: 1 }, reason: { effect: "unknown-availability", note: "presence unresolved" }, constraints: { requireDurableQueue: true } };
  },
};

/**
 * Rule: a diverged replica adds a synchronization constraint (sync must accompany delivery) without
 * necessarily overriding the primary strategy.
 */
export const divergenceRule = {
  id: "divergence",
  describe: "A diverged replica requires an accompanying sync step.",
  evaluate(ctx) {
    if (ctx.synchronization.state !== SyncState.DIVERGED) return {};
    return { reason: { effect: "attach-sync", note: "replica diverged" }, constraints: { requireSyncStep: true } };
  },
};

/**
 * Rule: urgent priority forbids queuing behind bulk + slightly biases direct (low latency).
 */
export const priorityRule = {
  id: "priority",
  describe: "Urgent requests must not queue behind bulk traffic.",
  evaluate(ctx) {
    if (ctx.transport.priority !== Priority.URGENT) return {};
    return { bias: { [StrategyType.DIRECT]: 1 }, reason: { effect: "urgent", note: "urgent priority" }, constraints: { noBulkQueue: true } };
  },
};

/**
 * Rule: a plain 1:1 direct text message with no other signal biases DIRECT (the baseline path).
 */
export const directBaselineRule = {
  id: "direct-baseline",
  describe: "Plain 1:1 text messages default to direct delivery.",
  evaluate(ctx) {
    if (ctx.conversation.type === ConversationType.DIRECT && ctx.media.type === MediaType.NONE) {
      return { bias: { [StrategyType.DIRECT]: 2 }, reason: { effect: "baseline-direct", note: "1:1 text" } };
    }
    return {};
  },
};

/**
 * The default, ordered rule set. A deployment can pass its own array (a superset / reordering) to the
 * engine. Order is stable + only affects the reason audit order, not correctness (biases are additive).
 */
export const DEFAULT_DECISION_RULES = Object.freeze([
  mediaRule,
  groupRule,
  syncRule,
  availabilityRule,
  divergenceRule,
  priorityRule,
  directBaselineRule,
]);

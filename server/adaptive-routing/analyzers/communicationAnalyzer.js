/**
 * @module adaptive-routing/analyzers/communicationAnalyzer
 *
 * The **Communication Analyzer** (STEP 4) — reduces a Sprint-1 immutable context into a normalized,
 * frozen **communication analysis**: the small set of derived signals the scorer + selector actually need
 * (type, conversation shape, group size, media type, payload class, priority, sync posture, offline
 * state, execution context). It never inspects payload bytes — it reads the opaque payload ref's declared
 * size only. Keeping this as one pure projection means the scoring dimensions all read from a single,
 * consistent view rather than re-deriving from the raw context.
 *
 * @security Pure control-plane projection — ids + classifications + sizes. No content.
 */

import { deepFreeze } from "../../communication-fabric/index.js";
import { PRIORITY_RANK, MediaType, ConversationType, PayloadClass, PAYLOAD_SIZE_CLASS } from "../types/types.js";

export class CommunicationAnalyzer {
  /**
   * Analyze a context into a normalized communication analysis.
   * @param {import("../../communication-fabric/index.js").CommunicationContext} context
   * @returns {object} frozen analysis
   */
  analyze(context) {
    const raw = context.raw ?? context;
    const payloadSize = raw.media?.payloadRef?.size ?? raw.media?.size ?? null;
    const groupSize = raw.conversation.type === ConversationType.GROUP ? raw.group?.memberHint ?? raw.recipient?.count ?? null : raw.recipient?.count ?? 0;

    return deepFreeze({
      communicationType: raw.type,
      conversationType: raw.conversation.type,
      groupSize,
      mediaType: raw.media.type,
      payloadSize,
      payloadClass: classifyPayload(raw.media.type, payloadSize),
      priority: raw.transport.priority,
      priorityRank: PRIORITY_RANK[raw.transport.priority] ?? PRIORITY_RANK.normal,
      syncState: raw.synchronization.state,
      offline: raw.recipient.availability === "offline",
      availability: raw.recipient.availability,
      // derived flags the scorers read directly
      isGroup: raw.conversation.type === ConversationType.GROUP,
      isSelf: raw.conversation.type === ConversationType.SELF,
      isMedia: raw.media.type !== MediaType.NONE,
      isLarge: classifyPayload(raw.media.type, payloadSize) === PayloadClass.LARGE,
      needsSync: raw.synchronization.state === "diverged",
      isRealtime: false, // voice/video are out of scope this sprint — always false
      executionContext: { attempt: raw.execution?.attempt ?? 1, requestId: raw.execution?.requestId ?? null },
    });
  }
}

/** Classify a payload by its declared size (media presence bumps the floor to MEDIUM). */
export function classifyPayload(mediaType, size) {
  if ((mediaType == null || mediaType === MediaType.NONE) && (size == null || size === 0)) return PayloadClass.NONE;
  if (size == null) return mediaType && mediaType !== MediaType.NONE ? PayloadClass.MEDIUM : PayloadClass.SMALL;
  if (size <= PAYLOAD_SIZE_CLASS.SMALL_MAX) return PayloadClass.SMALL;
  if (size <= PAYLOAD_SIZE_CLASS.MEDIUM_MAX) return PayloadClass.MEDIUM;
  return PayloadClass.LARGE;
}

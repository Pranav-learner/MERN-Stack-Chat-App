/**
 * @module group-receipts/aggregation/receiptPolicy
 *
 * **WhatsApp receipt logic** — the pure, CONFIGURABLE rules that map an aggregate's counters to a
 * delivery indicator:
 *
 * - **Single ✓** — the message exists but is NOT yet delivered to every applicable member.
 * - **Grey ✓✓** — delivered to every applicable member (not all read).
 * - **Blue ✓✓** — read by every read-applicable member.
 *
 * The policy is the seam for future privacy + business rules WITHOUT redesigning the architecture:
 * `readReceiptsEnabled: false` caps the indicator at grey (blue never shown); `readApplicableCount <
 * applicableCount` lets per-member privacy exclusions (a member who disabled read receipts) drop out of
 * the blue-tick requirement; member exclusions are applied upstream when the applicable set is built.
 *
 * Pure functions, no I/O.
 */

import { ReceiptTick, DEFAULT_RECEIPT_POLICY, ExclusionReason } from "../types/types.js";

/** Resolve a partial policy against the defaults. */
export function resolvePolicy(policy) {
  return { ...DEFAULT_RECEIPT_POLICY, ...(policy ?? {}) };
}

/**
 * Compute the receipt indicator from an aggregate. O(1). @param {object} aggregate
 * @param {object} [policy] @returns {string} one of {@link ReceiptTick}
 */
export function computeTick(aggregate, policy) {
  const p = resolvePolicy(policy);
  const applicable = aggregate.applicableCount ?? 0;
  // No applicable recipients (e.g. a solo group) → the message exists but reaches no one: single tick.
  if (applicable <= 0) return ReceiptTick.SINGLE;

  const delivered = aggregate.deliveredCount ?? 0;
  if ((p.requireAllDelivered ? delivered < applicable : delivered <= 0)) return ReceiptTick.SINGLE;

  // Delivered to every applicable member. Blue requires read receipts enabled + all read-applicable read.
  if (!p.readReceiptsEnabled) return ReceiptTick.GREY_DOUBLE;
  const readApplicable = aggregate.readApplicableCount ?? applicable;
  if (readApplicable <= 0) return ReceiptTick.GREY_DOUBLE; // nobody is counted for read → stay grey
  const read = aggregate.readCount ?? 0;
  if ((p.requireAllRead ? read < readApplicable : read <= 0)) return ReceiptTick.GREY_DOUBLE;
  return ReceiptTick.BLUE_DOUBLE;
}

/**
 * Build the APPLICABLE member set for a message from the group's members + the policy. Applies sender
 * exclusion + explicit exclusions + a per-member privacy hook (for read exclusions). Returns both the
 * delivery-applicable members and the read-applicable count. Pure.
 *
 * @param {object} params
 * @param {string[]} params.members active members at send time
 * @param {string} params.senderId @param {object} [params.policy]
 * @param {string[]} [params.excludeMembers] explicit exclusions (left / not-member / business rule)
 * @param {string[]} [params.readExcludedMembers] members excluded from READ counting only (privacy)
 * @param {(memberId: string) => boolean} [params.readReceiptHook] returns false if the member's reads are NOT tracked
 * @returns {{ applicableMembers: string[], readApplicableCount: number, exclusions: object[] }}
 */
export function buildApplicableSet(params) {
  const p = resolvePolicy(params.policy);
  const exclusions = [];
  const excluded = new Set((params.excludeMembers ?? []).map(String));
  const sender = String(params.senderId ?? "");

  const applicableMembers = [];
  for (const raw of params.members ?? []) {
    const memberId = String(raw);
    if (p.excludeSender && memberId === sender) {
      exclusions.push({ memberId, reason: ExclusionReason.SENDER });
      continue;
    }
    if (excluded.has(memberId)) {
      exclusions.push({ memberId, reason: ExclusionReason.BUSINESS_RULE });
      continue;
    }
    applicableMembers.push(memberId);
  }

  // Read-applicable = delivery-applicable minus members who disabled read receipts (privacy).
  const readExcluded = new Set((params.readExcludedMembers ?? []).map(String));
  let readApplicableCount = 0;
  for (const memberId of applicableMembers) {
    const hookAllows = params.readReceiptHook ? params.readReceiptHook(memberId) !== false : true;
    if (readExcluded.has(memberId) || !hookAllows) {
      exclusions.push({ memberId, reason: ExclusionReason.READ_RECEIPTS_OFF });
      continue;
    }
    readApplicableCount += 1;
  }
  if (!p.readReceiptsEnabled) readApplicableCount = 0;

  return { applicableMembers: [...new Set(applicableMembers)], readApplicableCount, exclusions };
}

export { ReceiptTick };

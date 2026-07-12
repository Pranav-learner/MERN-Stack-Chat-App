/**
 * @module group-receipts/analytics
 *
 * **Delivery analytics.** Derives message-level statistics from the incremental aggregate — delivery /
 * read latency (averaged from the aggregate's running sums, so it is O(1), never a per-member scan),
 * delivery / read percentages, pending + offline counts, and a compact stats block for dashboards.
 *
 * @security Analytics carry counts + latencies + percentages ONLY — never content or keys. Pure
 * functions.
 *
 * @performance All derived from the aggregate's running counters/sums → O(1). Offline enumeration (which
 * needs presence) is optional + supplied by the caller; the core analytics never scan members.
 */

/** Round to 2 decimals. */
function pct(n, d) {
  return d <= 0 ? 0 : Number(((n / d) * 100).toFixed(2));
}
function avg(sum, count) {
  return count <= 0 ? 0 : Math.round(sum / count);
}

/**
 * Compute analytics for a message from its aggregate. O(1). @param {object} aggregate
 * @param {{ offlineCount?: number, now?: number }} [options]
 */
export function computeAnalytics(aggregate, options = {}) {
  if (!aggregate) return null;
  const applicable = aggregate.applicableCount ?? 0;
  const readApplicable = aggregate.readApplicableCount ?? applicable;
  const delivered = aggregate.deliveredCount ?? 0;
  const read = aggregate.readCount ?? 0;
  const pending = Math.max(0, applicable - delivered);
  return {
    messageId: aggregate.messageId,
    groupId: aggregate.groupId,
    applicableMembers: applicable,
    deliveredMembers: delivered,
    readMembers: read,
    pendingMembers: pending,
    offlineMembers: options.offlineCount ?? null, // supplied by caller if presence is known
    failedMembers: aggregate.failedCount ?? 0,
    deliveryPercentage: pct(delivered, applicable),
    readPercentage: pct(read, readApplicable),
    avgDeliveryLatencyMs: avg(aggregate.deliveryLatencySumMs ?? 0, aggregate.deliveryLatencyCount ?? 0),
    avgReadLatencyMs: avg(aggregate.readLatencySumMs ?? 0, aggregate.readLatencyCount ?? 0),
    fullyDeliveredAt: aggregate.fullyDeliveredAt ?? null,
    fullyReadAt: aggregate.fullyReadAt ?? null,
    tick: aggregate.tick,
    sentAt: aggregate.sentAt,
    updatedAt: aggregate.updatedAt,
  };
}

/** A compact delivery-only statistics block. */
export function deliveryStats(aggregate) {
  const a = computeAnalytics(aggregate);
  if (!a) return null;
  return { applicableMembers: a.applicableMembers, deliveredMembers: a.deliveredMembers, pendingMembers: a.pendingMembers, failedMembers: a.failedMembers, deliveryPercentage: a.deliveryPercentage, avgDeliveryLatencyMs: a.avgDeliveryLatencyMs, fullyDeliveredAt: a.fullyDeliveredAt, tick: a.tick };
}

/** A compact read-only statistics block. */
export function readStats(aggregate) {
  const a = computeAnalytics(aggregate);
  if (!a) return null;
  return { readApplicableMembers: aggregate.readApplicableCount ?? a.applicableMembers, readMembers: a.readMembers, readPercentage: a.readPercentage, avgReadLatencyMs: a.avgReadLatencyMs, fullyReadAt: a.fullyReadAt, tick: a.tick };
}

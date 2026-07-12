/**
 * @module group-receipts
 *
 * **Layer 10 · Sprint 4 — Group Delivery Intelligence & Receipt Aggregation.** An INDEPENDENT subsystem
 * on top of the frozen Group Communication platform (Sprints 1–3): per-member delivery + read tracking
 * (multi-device, deduplicated), INCREMENTAL receipt aggregation, WhatsApp-style ✓ / ✓✓ / ✓✓-blue
 * indicators, delivery analytics, and a cache — all without touching the messaging, fan-out, or
 * synchronization architecture.
 *
 * @security Reasons over delivery CONTROL-PLANE metadata ONLY — message/member/device ids, delivery/read
 * states, timestamps, counts. Never message content or keys.
 *
 * @performance Receipt reads are O(1): every per-member transition applies a constant-time delta to a
 * single aggregate; a receipt query reads the aggregate (cache-fronted) and never scans the member set.
 *
 * @evolution The receipt POLICY (member exclusions, read-receipts-disabled, per-member privacy hooks) is
 * the configurable seam for future privacy + business rules WITHOUT architecture changes. The Group
 * Communication Engine consumes this subsystem via `attachToGroupComm`.
 *
 * @example
 * ```js
 * import { GroupReceiptManager, createInMemoryReceiptRepository, createReceiptApi } from "./group-receipts/index.js";
 * const mgr = new GroupReceiptManager({ ...createInMemoryReceiptRepository() });
 * const api = createReceiptApi(mgr);
 * await api.registerMessage({ messageId: "m1", groupId: "g", senderId: "alice", applicableMembers: ["bob", "carol"] });
 * await api.trackDelivery({ messageId: "m1", memberId: "bob", deviceId: "bob-web" });
 * const receipt = await api.getReceipt({ messageId: "m1" });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { GroupReceiptEventBus } from "./events/events.js";

// Delivery + read tracking
export { createMemberReceipt, applyDelivery, rollUpDeliveryStatus, isMemberDelivered } from "./delivery/deliveryTracker.js";
export { applyRead, readingDevices, isMemberRead } from "./reads/readTracker.js";

// Aggregation + policy + analytics
export { createAggregate, applyDeliveryDelta, applyReadDelta, applyFailureDelta, aggregateCounts } from "./aggregation/aggregator.js";
export { computeTick, resolvePolicy, buildApplicableSet, ReceiptTick } from "./aggregation/receiptPolicy.js";
export { computeAnalytics, deliveryStats, readStats } from "./analytics/analytics.js";

// Cache
export { ReceiptCache } from "./cache/receiptCache.js";

// Validators + serializers + dto
export * from "./validators/validators.js";
export { toReceiptView, toMemberReceiptView, toReaderView, toPendingView } from "./serializers/serializers.js";
export * from "./dto/dto.js";

// Repositories
export { createInMemoryReceiptRepository } from "./repository/inMemoryReceiptRepository.js";
export { createMongoReceiptRepository } from "./repository/mongoReceiptRepository.js";

// Manager + API
export { GroupReceiptManager } from "./manager/groupReceiptManager.js";
export { createReceiptApi } from "./api/receiptApi.js";

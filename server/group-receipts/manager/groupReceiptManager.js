/**
 * @module group-receipts/manager
 *
 * The **Group Delivery Intelligence Manager** — the reusable orchestrator for Layer 10, Sprint 4. It
 * tracks per-member delivery + read state (multi-device, deduplicated), aggregates them INCREMENTALLY
 * into a per-message receipt, computes the WhatsApp-style indicator (✓ / ✓✓ / ✓✓-blue), and exposes
 * analytics + diagnostics. It is an INDEPENDENT subsystem the Group Communication Engine consumes; it
 * does not touch the messaging, fan-out, or synchronization architecture.
 *
 * @performance The design guarantee: **receipt reads are O(1)**. Each `trackDelivery` / `trackRead`
 * applies a constant-time delta to the aggregate (multi-device dedup happens in the trackers, so each
 * counter moves at most once per member), and `getReceipt` reads the aggregate (cache-fronted) — it
 * never scans the member set. Only explicit LIST queries (readers / pending) are O(applicable).
 *
 * @security Reasons over delivery CONTROL-PLANE metadata ONLY — message/member/device ids, delivery/read
 * states, timestamps, counts. Never message content or keys; the no-content deep scan runs before every
 * persist.
 *
 * @example
 * ```js
 * const mgr = new GroupReceiptManager({ ...createInMemoryReceiptRepository() });
 * await mgr.registerMessage({ messageId: "m1", groupId: "g", senderId: "alice", applicableMembers: ["bob", "carol"] });
 * await mgr.trackDelivery({ messageId: "m1", memberId: "bob", deviceId: "bob-web" });
 * await mgr.trackRead({ messageId: "m1", memberId: "bob", deviceId: "bob-web" });
 * const receipt = await mgr.getReceipt("m1"); // { tick: "single", delivered: 1, read: 1, ... }
 * ```
 */

import crypto from "node:crypto";
import {
  ReceiptEventType,
  ReceiptTick,
  DeliveryStatus,
  GROUP_RECEIPTS_FRAMEWORK,
  GROUP_RECEIPTS_SCHEMA_VERSION,
} from "../types/types.js";
import { GroupReceiptError, NotApplicableMemberError } from "../errors.js";
import { GroupReceiptEventBus } from "../events/events.js";
import { createMemberReceipt, applyDelivery } from "../delivery/deliveryTracker.js";
import { applyRead } from "../reads/readTracker.js";
import { createAggregate, applyDeliveryDelta, applyReadDelta, applyFailureDelta, aggregateCounts } from "../aggregation/aggregator.js";
import { resolvePolicy, buildApplicableSet } from "../aggregation/receiptPolicy.js";
import { computeAnalytics, deliveryStats, readStats } from "../analytics/analytics.js";
import { ReceiptCache } from "../cache/receiptCache.js";
import { toReceiptView, toMemberReceiptView, toReaderView, toPendingView } from "../serializers/serializers.js";
import {
  validateRegister,
  validateReport,
  validateRef,
  validateDeliveryStatus,
  requireAggregate,
  validateAggregateInvariants,
  assertNoContent,
  normalizePagination,
  validateRepository,
} from "../validators/validators.js";

export class GroupReceiptManager {
  constructor(deps = {}) {
    validateRepository(deps);
    this.aggregates = deps.aggregates;
    this.memberReceipts = deps.memberReceipts;
    this.analyticsStore = deps.analytics ?? null;
    this.repo = deps;
    this.events = deps.events ?? new GroupReceiptEventBus();
    this.cache = deps.cache ?? new ReceiptCache({ clock: deps.clock });
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.defaultPolicy = resolvePolicy(deps.policy);
    this.readReceiptHook = deps.readReceiptHook ?? null; // (memberId) => boolean — privacy hook
    this.presenceResolver = deps.presenceResolver ?? null; // (memberId) => boolean — for offline lists
    this._locks = new Map();
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === registration =========================================================

  /**
   * Register a group message for receipt tracking. Builds the APPLICABLE member set (sender excluded by
   * policy, privacy exclusions for read counting) + the incremental aggregate. Idempotent.
   * @param {import("../dto/dto.js").RegisterMessageDTO} params @returns {Promise<object>}
   */
  async registerMessage(params) {
    validateRegister(params);
    const messageId = String(params.messageId);
    return this._withLock(messageId, async () => {
      const existing = await this.aggregates.findById(messageId);
      if (existing) return toReceiptView(existing);
      const policy = resolvePolicy(params.policy ?? this.defaultPolicy);
      const { applicableMembers, readApplicableCount } = buildApplicableSet({
        members: params.applicableMembers,
        senderId: params.senderId,
        policy,
        excludeMembers: params.excludeMembers,
        readExcludedMembers: params.readExcludedMembers,
        readReceiptHook: this.readReceiptHook,
      });
      const aggregate = createAggregate({ messageId, groupId: params.groupId, senderId: params.senderId, applicableMembers, readApplicableCount, policy, sentAt: params.sentAt ?? this._nowIso() });
      assertNoContent(aggregate, "aggregate");
      const stored = await this.aggregates.create(aggregate);
      await this.cache.set(messageId, toReceiptView(stored));
      await this._recordHistory("receipt", { messageId, groupId: stored.groupId, event: "registered", tick: stored.tick });
      this.events.emit(ReceiptEventType.MESSAGE_REGISTERED, { messageId, groupId: stored.groupId, applicable: stored.applicableCount, readApplicable: stored.readApplicableCount });
      return toReceiptView(stored);
    });
  }

  // === per-member delivery + read ==========================================

  /**
   * Track a delivery for one member device (multi-device aware). Increments the aggregate's delivered
   * counter ONCE per member (the member's first delivery). @param {object} params
   * @param {{ messageId, memberId, deviceId, status?, at?, deviceMeta? }} params @returns {Promise<object>}
   */
  async trackDelivery(params) {
    validateReport(params);
    validateDeliveryStatus(params.status);
    const messageId = String(params.messageId);
    return this._withLock(messageId, async () => {
      const aggregate = requireAggregate(await this.aggregates.findById(messageId), messageId);
      this._assertApplicable(aggregate, params.memberId);
      const at = params.at ?? this._nowIso();
      let record = (await this.memberReceipts.find(messageId, params.memberId)) ?? createMemberReceipt({ messageId, groupId: aggregate.groupId, memberId: params.memberId, sentAt: aggregate.sentAt, at });
      const status = params.status ?? DeliveryStatus.DELIVERED;
      const { record: next, memberBecameDelivered } = applyDelivery(record, { deviceId: params.deviceId, status, at, deviceMeta: params.deviceMeta });
      assertNoContent(next, "member receipt");
      await this.memberReceipts.upsert(next);

      if (status === DeliveryStatus.FAILED && !next.memberDelivered) {
        const failed = validateAggregateInvariants(applyFailureDelta(aggregate, { at }));
        await this.aggregates.update(messageId, { failedCount: failed.failedCount, version: failed.version });
        await this._refreshCache(messageId);
        return toMemberReceiptView(next);
      }
      if (memberBecameDelivered) await this._commitDelivery(aggregate, next, at);
      else await this._refreshCache(messageId);
      return toMemberReceiptView(next);
    });
  }

  /**
   * Track a read for one member device. A member counts as READ exactly ONCE even if several devices
   * report a read (dedup). Reading implies delivery. @param {object} params
   * @param {{ messageId, memberId, deviceId, at? }} params @returns {Promise<object>}
   */
  async trackRead(params) {
    validateReport(params);
    const messageId = String(params.messageId);
    return this._withLock(messageId, async () => {
      const aggregate = requireAggregate(await this.aggregates.findById(messageId), messageId);
      this._assertApplicable(aggregate, params.memberId);
      const at = params.at ?? this._nowIso();
      let record = (await this.memberReceipts.find(messageId, params.memberId)) ?? createMemberReceipt({ messageId, groupId: aggregate.groupId, memberId: params.memberId, sentAt: aggregate.sentAt, at });
      const { record: next, memberBecameRead, memberBecameDelivered } = applyRead(record, { deviceId: params.deviceId, at });
      assertNoContent(next, "member receipt");
      await this.memberReceipts.upsert(next);
      await this._commitRead(aggregate, next, { memberBecameRead, memberBecameDelivered, at });
      return toMemberReceiptView(next);
    });
  }

  /** @private commit a member's first delivery to the aggregate (O(1)) + emit + refresh cache. */
  async _commitDelivery(aggregate, record, at) {
    const { aggregate: next, fullyDelivered, tickChanged } = applyDeliveryDelta(aggregate, { latencyMs: record.deliveryLatencyMs, at });
    validateAggregateInvariants(next);
    const stored = await this.aggregates.update(aggregate.messageId, this._deliveryPatch(next));
    this.events.emit(ReceiptEventType.MEMBER_DELIVERED, { messageId: stored.messageId, memberId: record.memberId, delivered: stored.deliveredCount, applicable: stored.applicableCount });
    await this._afterAggregate(stored, { tickChanged, fullyDelivered });
  }

  /** @private commit a member's first read (+ possibly first delivery) to the aggregate (O(1)). */
  async _commitRead(aggregate, record, { memberBecameRead, memberBecameDelivered, at }) {
    if (!memberBecameRead && !memberBecameDelivered) {
      await this._refreshCache(aggregate.messageId); // duplicate read — no counter moved
      return;
    }
    const { aggregate: next, fullyRead, fullyDelivered, tickChanged } = applyReadDelta(aggregate, { becameDelivered: memberBecameDelivered, deliveryLatencyMs: record.deliveryLatencyMs, readLatencyMs: record.readLatencyMs, at });
    validateAggregateInvariants(next);
    const stored = await this.aggregates.update(aggregate.messageId, { ...this._deliveryPatch(next), readCount: next.readCount, readLatencySumMs: next.readLatencySumMs, readLatencyCount: next.readLatencyCount, fullyReadAt: next.fullyReadAt });
    if (memberBecameDelivered) this.events.emit(ReceiptEventType.MEMBER_DELIVERED, { messageId: stored.messageId, memberId: record.memberId, delivered: stored.deliveredCount, applicable: stored.applicableCount });
    this.events.emit(ReceiptEventType.MEMBER_READ, { messageId: stored.messageId, memberId: record.memberId, read: stored.readCount, readApplicable: stored.readApplicableCount });
    await this._afterAggregate(stored, { tickChanged, fullyDelivered, fullyRead });
  }

  /** @private common post-aggregate work: refresh cache, emit receipt/aggregation + milestone events. */
  async _afterAggregate(stored, { tickChanged, fullyDelivered, fullyRead } = {}) {
    const view = toReceiptView(stored);
    await this.cache.set(stored.messageId, view);
    this.events.emit(ReceiptEventType.AGGREGATION_UPDATED, { messageId: stored.messageId, tick: stored.tick, delivered: stored.deliveredCount, read: stored.readCount });
    if (tickChanged) this.events.emit(ReceiptEventType.RECEIPT_UPDATED, { messageId: stored.messageId, tick: stored.tick });
    if (fullyDelivered) {
      this.events.emit(ReceiptEventType.GROUP_FULLY_DELIVERED, { messageId: stored.messageId, at: stored.fullyDeliveredAt });
      this.events.emit(ReceiptEventType.DELIVERY_COMPLETED, { messageId: stored.messageId, applicable: stored.applicableCount });
    }
    if (fullyRead) this.events.emit(ReceiptEventType.GROUP_FULLY_READ, { messageId: stored.messageId, at: stored.fullyReadAt });
    await this._recordHistory("receipt", { messageId: stored.messageId, groupId: stored.groupId, event: "aggregation", tick: stored.tick });
  }

  _deliveryPatch(a) {
    return { deliveredCount: a.deliveredCount, deliveryLatencySumMs: a.deliveryLatencySumMs, deliveryLatencyCount: a.deliveryLatencyCount, fullyDeliveredAt: a.fullyDeliveredAt, tick: a.tick, version: a.version };
  }

  // === receipt reads (O(1)) ================================================

  /** The headline receipt (tick + counts). O(1) — cache-fronted. */
  async getReceipt(messageId, options = {}) {
    validateRef(messageId, "message identifier");
    if (!options.skipCache) {
      const cached = await this.cache.get(messageId);
      if (cached) return cached;
    }
    const aggregate = requireAggregate(await this.aggregates.findById(messageId), messageId);
    const view = toReceiptView(aggregate);
    await this.cache.set(messageId, view);
    return view;
  }

  /** The receipt tick only (WhatsApp indicator). O(1). */
  async getTick(messageId) {
    return (await this.getReceipt(messageId)).tick;
  }

  /** A single member's receipt. */
  async getMemberReceipt(messageId, memberId) {
    validateRef(messageId, "message identifier");
    validateRef(memberId, "member identifier");
    const record = await this.memberReceipts.find(messageId, memberId);
    return record ? toMemberReceiptView(record) : null;
  }

  /** The members who have READ the message (list — O(applicable)). */
  async getReaders(messageId, { limit, offset } = {}) {
    validateRef(messageId, "message identifier");
    const page = normalizePagination({ limit, offset });
    const records = await this.memberReceipts.listByMessage(messageId, { filter: "read", limit: page.limit, offset: page.offset });
    const total = await this.memberReceipts.countByMessage(messageId, "read");
    return { total, readers: records.map(toReaderView) };
  }

  /** The members still PENDING (not yet delivered) — list. Applicable snapshot minus delivered. */
  async getPendingMembers(messageId, { limit, offset } = {}) {
    const aggregate = requireAggregate(await this.aggregates.findById(messageId), messageId);
    const delivered = new Set((await this.memberReceipts.listByMessage(messageId, { filter: "delivered" })).map((r) => r.memberId));
    let pending = (aggregate.applicableMembers ?? []).filter((m) => !delivered.has(m));
    const total = pending.length;
    const page = normalizePagination({ limit, offset });
    pending = pending.slice(page.offset, page.offset + page.limit);
    const out = [];
    for (const memberId of pending) out.push(toPendingView(memberId, await this.memberReceipts.find(messageId, memberId)));
    return { total, pending: out };
  }

  /** The pending members who are currently OFFLINE (uses the injected presence resolver). */
  async getOfflineMembers(messageId, options = {}) {
    const { pending } = await this.getPendingMembers(messageId, { limit: options.limit ?? 1000 });
    if (!this.presenceResolver) return { total: pending.length, offline: pending, note: "no presence resolver — all pending returned as waiting" };
    const offline = [];
    for (const p of pending) if ((await this.presenceResolver(p.memberId)) === false) offline.push(p);
    return { total: offline.length, offline };
  }

  // === analytics ============================================================

  /** Full analytics for a message (O(1) from the aggregate + optional offline count). */
  async getAnalytics(messageId, options = {}) {
    const aggregate = requireAggregate(await this.aggregates.findById(messageId), messageId);
    let offlineCount = options.offlineCount;
    if (offlineCount == null && this.presenceResolver && options.computeOffline) {
      offlineCount = (await this.getOfflineMembers(messageId)).total;
    }
    const analytics = computeAnalytics(aggregate, { offlineCount, now: this.clock() });
    if (this.analyticsStore) await this.analyticsStore.upsert(analytics);
    this.events.emit(ReceiptEventType.ANALYTICS_UPDATED, { messageId, deliveryPercentage: analytics.deliveryPercentage, readPercentage: analytics.readPercentage });
    return analytics;
  }

  async getDeliveryStats(messageId) {
    return deliveryStats(requireAggregate(await this.aggregates.findById(messageId), messageId));
  }
  async getReadStats(messageId) {
    return readStats(requireAggregate(await this.aggregates.findById(messageId), messageId));
  }

  /** Diagnostics: aggregate + counts + cache stats. */
  async getDiagnostics(messageId) {
    const aggregate = requireAggregate(await this.aggregates.findById(messageId), messageId);
    return { receipt: toReceiptView(aggregate), counts: aggregateCounts(aggregate), analytics: computeAnalytics(aggregate, { now: this.clock() }), cache: this.cache.stats() };
  }

  /** Recent receipts for a group (dashboard). */
  async listGroupReceipts(groupId, { limit } = {}) {
    validateRef(groupId, "group identifier");
    return (await this.aggregates.listByGroup(groupId, { limit })).map(toReceiptView);
  }

  async health() {
    return { framework: GROUP_RECEIPTS_FRAMEWORK, schemaVersion: GROUP_RECEIPTS_SCHEMA_VERSION, cache: this.cache.stats(), at: this._nowIso() };
  }

  // === group-communication integration seam ================================

  /**
   * Attach to a Sprint-2 Group Communication event bus so delivery-leg + read events auto-drive receipts.
   * `resolveMember(deviceId) → memberId` maps a device to its member (Sprint-2 events carry deviceId). A
   * `GroupCommEventType.DELIVERY_UPDATED` with state "delivered" → trackDelivery; a
   * `GROUP_MESSAGE_RECEIVED` → trackRead (a device confirming receipt has the plaintext → read). This
   * keeps the receipt subsystem INDEPENDENT — the engine is never modified. @returns {() => void}
   */
  attachToGroupComm(bus, { resolveMember } = {}) {
    const toMember = resolveMember ?? ((d) => String(d));
    const offs = [];
    offs.push(bus.on("group-comm.delivery_updated", (e) => {
      if (e.state === "delivered") this.trackDelivery({ messageId: e.messageId, memberId: toMember(e.deviceId), deviceId: e.deviceId }).catch(() => {});
      else if (e.state === "failed") this.trackDelivery({ messageId: e.messageId, memberId: toMember(e.deviceId), deviceId: e.deviceId, status: DeliveryStatus.FAILED }).catch(() => {});
    }));
    offs.push(bus.on("group-comm.message_received", (e) => {
      this.trackRead({ messageId: e.messageId, memberId: toMember(e.deviceId), deviceId: e.deviceId }).catch(() => {});
    }));
    return () => offs.forEach((off) => off());
  }

  // === internals ============================================================

  _assertApplicable(aggregate, memberId) {
    // A member not in the applicable snapshot (e.g. the sender / an excluded member) is a no-op target.
    if (!(aggregate.applicableMembers ?? []).includes(String(memberId))) {
      throw new NotApplicableMemberError("Member is not in this message's applicable set", { details: { messageId: aggregate.messageId, memberId } });
    }
  }

  async _refreshCache(messageId) {
    const aggregate = await this.aggregates.findById(messageId);
    if (aggregate) await this.cache.set(messageId, toReceiptView(aggregate));
  }

  async _recordHistory(kind, entry) {
    try {
      await this.repo[kind === "receipt" ? "receiptHistory" : "audit"]?.record?.({ ...entry, at: this._nowIso() });
    } catch {
      /* history persistence failure must never break the receipt path */
    }
  }

  /** @private serialize per-message mutations so concurrent delivery/read reports don't lose a counter. */
  async _withLock(messageId, fn) {
    const key = String(messageId);
    const prev = this._locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    const tail = prev.then(() => gate);
    this._locks.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === tail) this._locks.delete(key);
    }
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/**
 * @module group-communication/manager
 *
 * The **Group Communication Engine** — the reusable orchestrator for Layer 10, Sprint 2. It turns the
 * Sprint-1 Group Foundation into a live, end-to-end-encrypted channel by composing six responsibilities:
 *
 *  1. **Secure group messaging** — accept OPAQUE ciphertext, stamp it with the active key version, and
 *     persist a blind message record.
 *  2. **Group key management** — establish / rotate / expire versioned epoch keys (metadata only).
 *  3. **Membership rekeying** — react to Sprint-1 membership events by rotating the key (fresh secret on
 *     departure so a leaver can't derive the next epoch).
 *  4. **Fan-out** — build a per-device delivery plan and dispatch each online leg through the INJECTED
 *     Layer 8 reliable-messaging engine; defer offline legs.
 *  5. **Group synchronization** — reconcile a device's replica after it reconnects (reusing the Layer 9
 *     delta model).
 *  6. **Offline-member support** — queue deliveries + rekeys for offline devices and resume on reconnect.
 *
 * @security The engine is a control plane + BLIND relay. It stores key METADATA (fingerprints, versions)
 * and OPAQUE ciphertext — never key bytes or plaintext. Fan-out carries the ciphertext only on the
 * Layer 8 leg. Every persisted object passes {@link assertNoSecretMaterial}.
 *
 * @evolution Transport-, discovery-, connectivity-INDEPENDENT (all injected). Fan-out reuses Layer 8;
 * keys reuse the Layer 5 HKDF primitives; sync reuses the Layer 9 delta model; membership comes from the
 * Sprint-1 Group Manager. It does NOT implement monitoring / hardening (Sprint 3) or read receipts /
 * delivery aggregation (Sprint 4) — the events are the seam those consume.
 *
 * @example
 * ```js
 * const engine = new GroupCommunicationEngine({ ...createInMemoryGroupCommRepository(), directory, messagingSend });
 * await engine.establishGroupKey({ groupId, actorId: "alice" });
 * await engine.sendGroupMessage({ groupId, senderId: "alice", senderDeviceId: "alice-web", ciphertext });
 * ```
 */

import crypto from "node:crypto";
import {
  GroupCommEventType,
  GroupDeliveryState,
  FanoutStatus,
  RekeyTrigger,
  GroupSyncFacet,
  GROUP_COMM_FRAMEWORK,
  GROUP_COMM_SCHEMA_VERSION,
  DEFAULT_MAX_FANOUT,
  DEFAULT_MAX_DEVICES_PER_MEMBER,
} from "../types/types.js";
import { GroupCommError, GroupNotFoundError, UnauthorizedMemberError } from "../errors.js";
import { GroupCommEventBus } from "../events/events.js";
import { GroupKeyManager } from "../key-management/keyManager.js";
import { createLocalKeyProvider, memberSetHash } from "../key-management/groupKey.js";
import { planRekey, MEMBERSHIP_EVENT_TO_TRIGGER, requiresFreshSecret } from "../key-management/rekey.js";
import { createGroupMessage, groupMessageRef } from "../messaging/groupMessage.js";
import { generateFanoutPlan, recomputeFanoutStatus, validateFanoutPlan } from "../fanout/fanoutPlanner.js";
import { transitionLeg, DeliveryGuard, summarizeLegs } from "../delivery/delivery.js";
import { buildCommReplica, applyReplicaUpdate, normalizeFacetVersions } from "../replicas/groupCommReplica.js";
import { createGroupSyncPlan, validateSyncPlan } from "../synchronization/groupSync.js";
import {
  validateRef,
  validateSendRequest,
  assertNoSecretMaterial,
  assertAuthorizedMember,
  normalizePagination,
  validateRepository,
} from "../validators/validators.js";
import {
  toKeyView,
  toMessageView,
  toFanoutView,
  toReplicaView,
  toSyncPlanView,
  toDeliveryStatusView,
} from "../serializers/serializers.js";

export class GroupCommunicationEngine {
  constructor(deps = {}) {
    validateRepository(deps);
    this.repo = deps;
    this.keys = deps.keys;
    this.messages = deps.messages;
    this.fanoutPlans = deps.fanoutPlans;
    this.replicas = deps.replicas;
    this.pendingQueue = deps.pendingQueue;
    this.events = deps.events ?? new GroupCommEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.keyManager = deps.keyManager ?? new GroupKeyManager({ keys: deps.keys, keyAudit: deps.keyAudit, clock: this.clock, keyTtlMs: deps.keyTtlMs });

    // Injected seams (reuse of earlier layers) — all optional with safe defaults.
    this.directory = deps.directory ?? null; // { getActiveMembers(groupId), getGroupVersions?(groupId) }
    this.deviceResolver = deps.deviceResolver ?? (async (memberId) => [String(memberId)]);
    this.presenceResolver = deps.presenceResolver ?? (async () => true);
    this.keyProvider = deps.keyProvider ?? createLocalKeyProvider({ randomBytes: deps.randomBytes });
    this.messagingSend = deps.messagingSend ?? this._defaultMessagingSend();

    this.maxFanout = deps.maxFanout ?? DEFAULT_MAX_FANOUT;
    this.maxDevicesPerMember = deps.maxDevicesPerMember ?? DEFAULT_MAX_DEVICES_PER_MEMBER;
    this.deliveryGuard = deps.deliveryGuard ?? new DeliveryGuard();
    this._locks = new Map();
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /**
   * Auto-wire membership rekeying: subscribe to a Sprint-1 group event bus so joins / leaves / removals
   * / ownership transfers rotate the group key automatically. @returns {() => void} unsubscribe-all
   */
  attachToGroupEvents(groupEventBus) {
    const offs = [];
    for (const [eventType, trigger] of Object.entries(MEMBERSHIP_EVENT_TO_TRIGGER)) {
      offs.push(groupEventBus.on(eventType, (e) => this.handleMembershipChange({ groupId: e.groupId, trigger, memberId: e.memberId ?? e.to ?? e.from }).catch(() => {})));
    }
    return () => offs.forEach((off) => off());
  }

  // === group key management =================================================

  /** Establish the INITIAL group key (version 1). Idempotent-ish (throws if one exists). */
  async establishGroupKey({ groupId, actorId, fingerprint, ttlMs } = {}) {
    validateRef(groupId, "group identifier");
    return this._withLock(groupId, async () => {
      const members = await this._activeMemberIds(groupId);
      this._assertMember(members, actorId, groupId);
      const fp = fingerprint ?? (await this.keyProvider({ groupId, keyVersion: 1, fresh: true })).fingerprint;
      const key = await this.keyManager.createInitialKey({ groupId, createdBy: actorId, fingerprint: fp, memberIds: members, trigger: RekeyTrigger.MANUAL, ttlMs });
      this.events.emit(GroupCommEventType.GROUP_KEY_ROTATED, { groupId: String(groupId), keyVersion: key.keyVersion, trigger: key.trigger, fingerprint: key.fingerprint });
      await this._refreshGroupReplicas(groupId, key.keyVersion);
      return toKeyView(key);
    });
  }

  /**
   * Rotate the group key (rekey). @param {{ groupId, actorId, trigger, fingerprint?, affectedMember?, ttlMs? }} params
   * @returns {Promise<object>} the new key view.
   */
  async rotateGroupKey(params) {
    validateRef(params.groupId, "group identifier");
    const trigger = params.trigger ?? RekeyTrigger.MANUAL;
    return this._withLock(params.groupId, async () => {
      const members = await this._activeMemberIds(params.groupId);
      const current = await this.keyManager.getActiveKey(params.groupId);
      const plan = planRekey({ trigger, members, affectedMember: params.affectedMember, currentVersion: current?.keyVersion ?? 0 });
      const fp = params.fingerprint ?? (await this.keyProvider({ groupId: params.groupId, keyVersion: plan.targetVersion, fresh: plan.fresh })).fingerprint;
      const key = await this.keyManager.rotateKey({ groupId: params.groupId, createdBy: params.actorId ?? "system", fingerprint: fp, memberIds: members, trigger, ttlMs: params.ttlMs });
      this.events.emit(GroupCommEventType.MEMBER_REKEYED, { groupId: String(params.groupId), keyVersion: key.keyVersion, trigger, fresh: plan.fresh, affectedMember: params.affectedMember ?? null });
      this.events.emit(GroupCommEventType.GROUP_KEY_ROTATED, { groupId: String(params.groupId), keyVersion: key.keyVersion, trigger, fingerprint: key.fingerprint });
      await this._refreshGroupReplicas(params.groupId, key.keyVersion);
      return toKeyView(key);
    });
  }

  /**
   * React to a Sprint-1 membership change by rotating the key (automatic rekeying). A departure uses a
   * FRESH secret. If there is no active key yet, it is a no-op (establish first).
   */
  async handleMembershipChange({ groupId, trigger, memberId } = {}) {
    validateRef(groupId, "group identifier");
    if (!(await this.keyManager.getActiveKey(groupId))) return { rekeyed: false, reason: "no-active-key" };
    const t = trigger ?? RekeyTrigger.MANUAL;
    const affectedMember = requiresFreshSecret(t) ? memberId : undefined;
    const key = await this.rotateGroupKey({ groupId, actorId: "system", trigger: t, affectedMember });
    return { rekeyed: true, keyVersion: key.keyVersion, trigger: t };
  }

  /** The current key version + active key view. */
  async getKeyVersion({ groupId }) {
    validateRef(groupId, "group identifier");
    const key = await this.keyManager.getActiveKey(groupId);
    return { groupId: String(groupId), keyVersion: key?.keyVersion ?? 0, key: toKeyView(key) };
  }

  /** All key versions for a group. */
  async listKeys({ groupId }) {
    return (await this.keyManager.listKeys(groupId)).map(toKeyView);
  }

  /** Key audit trail. */
  async getKeyAudit({ groupId, limit }) {
    return this.keyManager.getKeyAudit(groupId, { limit });
  }

  /** Sweep expired keys for a group. */
  async sweepExpiredKeys({ groupId }) {
    const expired = await this.keyManager.sweepExpired(groupId);
    for (const keyVersion of expired) this.events.emit(GroupCommEventType.GROUP_KEY_EXPIRED, { groupId: String(groupId), keyVersion });
    return { expired };
  }

  // === secure group messaging + fan-out =====================================

  /**
   * Send an end-to-end-encrypted group message. Accepts OPAQUE ciphertext, generates a fan-out plan,
   * dispatches online legs over Layer 8, and defers offline legs. @returns {Promise<object>}
   * @param {{ groupId, senderId, senderDeviceId, ciphertext, keyVersion?, priority?, metadata? }} request
   */
  async sendGroupMessage(request) {
    validateSendRequest(request);
    const members = await this._activeMemberIds(request.groupId);
    this._assertMember(members, request.senderId, request.groupId);
    const activeKey = await this.keyManager.requireActiveKey(request.groupId);
    if (request.keyVersion != null && Number(request.keyVersion) !== activeKey.keyVersion) {
      // The sender used a stale epoch — accept it if the version still exists + is usable (superseded ok).
      const used = await this.keyManager.requireKeyVersion(request.groupId, request.keyVersion);
      this.keyManager.assertUsable(used);
    }
    const keyVersion = request.keyVersion != null ? Number(request.keyVersion) : activeKey.keyVersion;

    const message = createGroupMessage({ groupId: request.groupId, senderId: request.senderId, keyVersion, ciphertext: request.ciphertext, priority: request.priority, metadata: request.metadata, clock: this.clock, idGenerator: this.idGenerator });
    assertNoSecretMaterial({ ...message, ciphertext: undefined }, "group message");
    const stored = await this.messages.create(message);
    this.events.emit(GroupCommEventType.GROUP_MESSAGE_SENT, { ...groupMessageRef(stored) });

    // Build + persist the fan-out plan.
    const recipients = await this._resolveRecipients(request.groupId, members);
    let plan = generateFanoutPlan({ message: groupMessageRef(stored), recipients, senderDeviceId: request.senderDeviceId, maxFanout: this.maxFanout, maxDevicesPerMember: this.maxDevicesPerMember, clock: this.clock, idGenerator: this.idGenerator });
    validateFanoutPlan(plan);
    plan.status = plan.legs.length ? FanoutStatus.IN_PROGRESS : FanoutStatus.COMPLETED;
    plan = await this.fanoutPlans.create(plan);
    this.events.emit(GroupCommEventType.FANOUT_STARTED, { groupId: String(request.groupId), messageId: stored.messageId, planId: plan.planId, legs: plan.legs.length });

    // Dispatch online legs; defer offline.
    plan = await this._dispatchPlan(plan, { ciphertext: request.ciphertext, senderDeviceId: request.senderDeviceId, priority: message.priority });

    this.events.emit(GroupCommEventType.FANOUT_COMPLETED, { groupId: String(request.groupId), messageId: stored.messageId, planId: plan.planId, status: plan.status, summary: plan.summary });
    await this._audit("deliveryAudit", { groupId: request.groupId, messageId: stored.messageId, action: "fanout", detail: plan.summary });
    return { message: toMessageView(stored), fanout: toFanoutView(plan, { includeLegs: true }) };
  }

  /**
   * A device acknowledges receipt of a group message (inbound). Marks its leg delivered + advances its
   * replica cursor. At-most-once per device. @returns {Promise<object>}
   */
  async receiveGroupMessage({ groupId, deviceId, messageId, memberId } = {}) {
    validateRef(groupId, "group identifier");
    validateRef(deviceId, "device identifier");
    validateRef(messageId, "message identifier");
    const message = await this.messages.findById(messageId);
    if (!message) throw new GroupCommError("Group message not found", { code: "ERR_GROUP_COMM_VALIDATION", status: 404, reason: "malformed-payload", details: { messageId } });
    if (!this.deliveryGuard.has(messageId, deviceId)) this.deliveryGuard.mark(messageId, deviceId);
    let plan = await this.fanoutPlans.findByMessage(messageId);
    if (plan) plan = await this._setLegState(plan, deviceId, GroupDeliveryState.DELIVERED, { at: this._nowIso() });
    await this._advanceReplicaCursor(groupId, deviceId, memberId, message);
    this.events.emit(GroupCommEventType.GROUP_MESSAGE_RECEIVED, { groupId: String(groupId), messageId, deviceId: String(deviceId) });
    return { messageId, deviceId: String(deviceId), delivered: true };
  }

  /** A message's public DTO (ciphertext included for a member). */
  async getMessage({ groupId, messageId, includeCiphertext = false }) {
    const message = await this.messages.findById(messageId);
    if (!message || message.groupId !== String(groupId)) throw new GroupCommError("Group message not found", { code: "ERR_GROUP_COMM_VALIDATION", status: 404, reason: "malformed-payload" });
    return toMessageView(message, { includeCiphertext });
  }

  /** Recent group messages (metadata only). */
  async listMessages({ groupId, limit, offset }) {
    const page = normalizePagination({ limit, offset });
    const list = await this.messages.listByGroup(groupId, { limit: page.limit, offset: page.offset });
    return list.map((m) => toMessageView(m));
  }

  /** A message's fan-out plan. */
  async getFanoutPlan({ messageId }) {
    const plan = await this.fanoutPlans.findByMessage(messageId);
    return plan ? toFanoutView(plan, { includeLegs: true }) : null;
  }

  /** A message's delivery status (per-leg roll-up). */
  async getDeliveryStatus({ groupId, messageId }) {
    const plan = await this.fanoutPlans.findByMessage(messageId);
    if (!plan || plan.groupId !== String(groupId)) throw new GroupCommError("No fan-out plan for this message", { code: "ERR_GROUP_COMM_VALIDATION", status: 404, reason: "invalid-fanout-plan" });
    return toDeliveryStatusView(plan);
  }

  /** Fan-out diagnostics for a group (recent plans + roll-up). */
  async fanoutDiagnostics({ groupId, limit = 20 }) {
    const plans = await this.fanoutPlans.listByGroup(groupId, { limit });
    const totals = plans.reduce((acc, p) => {
      const s = p.summary ?? summarizeLegs(p.legs ?? []);
      acc.delivered += s.delivered ?? 0;
      acc.queued += s.queued ?? 0;
      acc.failed += s.failed ?? 0;
      acc.plans += 1;
      return acc;
    }, { plans: 0, delivered: 0, queued: 0, failed: 0 });
    return { groupId: String(groupId), totals, recent: plans.map((p) => toFanoutView(p)) };
  }

  // === offline member support ===============================================

  /**
   * Resume deferred deliveries for a device that has reconnected. Drains the pending queue, dispatches
   * each over Layer 8, and marks the legs. @returns {Promise<object>}
   */
  async resumeDelivery({ groupId, deviceId }) {
    validateRef(groupId, "group identifier");
    validateRef(deviceId, "device identifier");
    const drained = await this.pendingQueue.drainDevice(groupId, deviceId);
    let resumed = 0;
    for (const entry of drained) {
      const message = await this.messages.findById(entry.messageId);
      if (!message) continue;
      try {
        const result = await this._deliver({ groupId, receiverDeviceId: deviceId, message, priority: entry.priority });
        let plan = await this.fanoutPlans.findByMessage(entry.messageId);
        if (plan) await this._setLegState(plan, deviceId, result.delivered ? GroupDeliveryState.DELIVERED : GroupDeliveryState.DISPATCHED, { messageRef: result.messageRef, at: this._nowIso() });
        resumed += 1;
      } catch {
        /* leave queued for the next attempt */
      }
    }
    if (resumed) this.events.emit(GroupCommEventType.OFFLINE_MEMBER_RESUMED, { groupId: String(groupId), deviceId: String(deviceId), resumed });
    return { groupId: String(groupId), deviceId: String(deviceId), resumed, pending: drained.length - resumed };
  }

  /** Members with queued (deferred) deliveries. */
  async getPendingMembers({ groupId }) {
    validateRef(groupId, "group identifier");
    const pending = await this.pendingQueue.listByGroup(groupId);
    const byMember = {};
    for (const e of pending) {
      const key = e.memberId ?? e.deviceId;
      byMember[key] = byMember[key] ?? { memberId: e.memberId ?? null, devices: new Set(), count: 0 };
      byMember[key].devices.add(e.deviceId);
      byMember[key].count += 1;
    }
    return Object.values(byMember).map((m) => ({ memberId: m.memberId, devices: [...m.devices], pending: m.count }));
  }

  // === group synchronization + replicas =====================================

  /** Register (or refresh) a device's group-communication replica. */
  async registerReplica({ groupId, deviceId, memberId, facetVersions, keyVersion }) {
    validateRef(groupId, "group identifier");
    validateRef(deviceId, "device identifier");
    const activeKey = await this.keyManager.getActiveKey(groupId);
    const replica = buildCommReplica({ groupId, deviceId, memberId, facetVersions, keyVersion: keyVersion ?? activeKey?.keyVersion ?? 0, clock: this.clock, idGenerator: this.idGenerator });
    assertNoSecretMaterial(replica, "comm replica");
    const stored = await this.replicas.upsert(replica);
    this.events.emit(GroupCommEventType.REPLICA_UPDATED, { groupId: String(groupId), deviceId: String(deviceId), fingerprint: stored.fingerprint });
    return toReplicaView(stored);
  }

  /**
   * Synchronize a device: compute the facet delta it is missing (membership / metadata / key-version /
   * replica), advance its replica, resume any deferred deliveries, and return a resumable sync plan.
   */
  async synchronizeGroup({ groupId, deviceId, memberId, replica: incoming } = {}) {
    validateRef(groupId, "group identifier");
    validateRef(deviceId, "device identifier");
    this.events.emit(GroupCommEventType.SYNCHRONIZATION_STARTED, { groupId: String(groupId), deviceId: String(deviceId) });
    const authoritative = await this._authoritativeFacets(groupId);

    // Load or build the device replica.
    let replica = incoming ?? (await this.replicas.findByDevice(groupId, deviceId)) ?? buildCommReplica({ groupId, deviceId, memberId, keyVersion: 0, clock: this.clock, idGenerator: this.idGenerator });

    // Missed messages after the device's delivery cursor (refs only).
    const cursorAt = replica.deliveryCursor?.at ?? null;
    const missed = await this.messages.listAfter(groupId, cursorAt);

    const plan = createGroupSyncPlan({ replica, authoritative, missedMessages: missed.map(groupMessageRef), clock: this.clock, idGenerator: this.idGenerator });
    validateSyncPlan(plan);

    // Apply the authoritative facet versions to the replica (monotonic).
    const activeKey = await this.keyManager.getActiveKey(groupId);
    const { replica: updated, advanced } = applyReplicaUpdate(replica, authoritative, { keyVersion: activeKey?.keyVersion ?? replica.keyVersion, at: this._nowIso() });
    const persisted = await this.replicas.upsert(updated);

    // Resume any deferred deliveries for this device.
    const resume = await this.resumeDelivery({ groupId, deviceId });

    await this._audit("syncHistory", { groupId, deviceId, action: "synchronized", detail: { advanced, missed: missed.length, resumed: resume.resumed } });
    this.events.emit(GroupCommEventType.REPLICA_UPDATED, { groupId: String(groupId), deviceId: String(deviceId), fingerprint: persisted.fingerprint });
    this.events.emit(GroupCommEventType.SYNCHRONIZATION_COMPLETED, { groupId: String(groupId), deviceId: String(deviceId), advanced, missed: missed.length });
    return { plan: toSyncPlanView(plan), replica: toReplicaView(persisted), advanced, missedMessages: plan.missedMessages, resumed: resume.resumed };
  }

  /** A device's replica. */
  async getReplica({ groupId, deviceId }) {
    const replica = await this.replicas.findByDevice(groupId, deviceId);
    return replica ? toReplicaView(replica) : null;
  }

  /** All replicas for a group (diagnostics). */
  async listReplicas({ groupId }) {
    return (await this.replicas.listByGroup(groupId)).map(toReplicaView);
  }

  /** Aggregate control-plane health. */
  async health() {
    return { framework: GROUP_COMM_FRAMEWORK, schemaVersion: GROUP_COMM_SCHEMA_VERSION, at: this._nowIso() };
  }

  // === internals ============================================================

  /** @private the active member ids for a group (from the injected directory). */
  async _activeMemberIds(groupId) {
    if (!this.directory || typeof this.directory.getActiveMembers !== "function") {
      throw new GroupCommError("No group directory configured", { code: "ERR_GROUP_COMM_VALIDATION", status: 500, reason: "internal-error" });
    }
    const members = await this.directory.getActiveMembers(groupId);
    if (members == null) throw new GroupNotFoundError("Group not found", { details: { groupId } });
    return members.map((m) => String(m.memberId ?? m));
  }

  /** @private assert a member is authorized. */
  _assertMember(memberIds, memberId, groupId) {
    if (!memberId) throw new UnauthorizedMemberError("Missing member", { details: { groupId } });
    assertAuthorizedMember(memberIds, memberId);
  }

  /** @private resolve recipients → devices → presence. */
  async _resolveRecipients(groupId, memberIds) {
    const recipients = [];
    for (const memberId of memberIds) {
      const deviceIds = await this.deviceResolver(memberId);
      const devices = [];
      for (const deviceId of deviceIds ?? []) devices.push({ deviceId: String(deviceId), online: !!(await this.presenceResolver(deviceId)) });
      recipients.push({ memberId, devices });
    }
    return recipients;
  }

  /** @private the group's authoritative facet versions (for sync). */
  async _authoritativeFacets(groupId) {
    const activeKey = await this.keyManager.getActiveKey(groupId);
    let versions = {};
    if (this.directory?.getGroupVersions) versions = (await this.directory.getGroupVersions(groupId)) ?? {};
    const memberCount = (await this._activeMemberIds(groupId).catch(() => [])).length;
    return {
      [GroupSyncFacet.MEMBERSHIP]: versions.membership ?? memberCount,
      [GroupSyncFacet.METADATA]: versions.metadata ?? 1,
      [GroupSyncFacet.KEY_VERSION]: activeKey?.keyVersion ?? 0,
      [GroupSyncFacet.REPLICA]: versions.replica ?? versions.group ?? 1,
    };
  }

  /** @private dispatch a plan's legs (online → Layer 8; offline → pending queue). */
  async _dispatchPlan(plan, { ciphertext, senderDeviceId, priority }) {
    const legs = [];
    for (const leg of plan.legs) {
      if (leg.online) {
        // PLANNED → DISPATCHED (records the attempt) before the transport call, so a delivery failure
        // is a legal DISPATCHED → FAILED transition and a success is DISPATCHED → DELIVERED.
        const dispatched = transitionLeg(leg, GroupDeliveryState.DISPATCHED, { attempts: leg.attempts + 1 }, this._nowIso());
        try {
          const message = { messageId: plan.messageId, keyVersion: plan.keyVersion, ciphertext };
          const result = await this._deliver({ groupId: plan.groupId, receiverDeviceId: leg.deviceId, message, priority, senderDeviceId });
          const finalLeg = result.delivered ? transitionLeg(dispatched, GroupDeliveryState.DELIVERED, { messageRef: result.messageRef }, this._nowIso()) : { ...dispatched, messageRef: result.messageRef };
          legs.push(finalLeg);
          this.events.emit(GroupCommEventType.DELIVERY_UPDATED, { groupId: plan.groupId, messageId: plan.messageId, deviceId: leg.deviceId, state: finalLeg.state });
        } catch (error) {
          legs.push(transitionLeg(dispatched, GroupDeliveryState.FAILED, { lastError: error?.message ?? "delivery failed" }, this._nowIso()));
          this.events.emit(GroupCommEventType.DELIVERY_UPDATED, { groupId: plan.groupId, messageId: plan.messageId, deviceId: leg.deviceId, state: GroupDeliveryState.FAILED });
        }
      } else {
        await this.pendingQueue.enqueue({ groupId: plan.groupId, deviceId: leg.deviceId, memberId: leg.memberId, messageId: plan.messageId, keyVersion: plan.keyVersion, priority: leg.priority });
        legs.push({ ...leg, state: GroupDeliveryState.QUEUED, updatedAt: this._nowIso() });
        this.events.emit(GroupCommEventType.OFFLINE_MEMBER_QUEUED, { groupId: plan.groupId, messageId: plan.messageId, deviceId: leg.deviceId, memberId: leg.memberId });
      }
    }
    const recomputed = recomputeFanoutStatus({ ...plan, legs });
    return this.fanoutPlans.update(plan.planId, { legs, status: recomputed.status, summary: recomputed.summary });
  }

  /** @private deliver one leg over the injected Layer 8 messaging hook. */
  async _deliver({ groupId, receiverDeviceId, message, priority, senderDeviceId }) {
    if (!this.deliveryGuard.has(message.messageId, receiverDeviceId)) this.deliveryGuard.mark(message.messageId, receiverDeviceId);
    const result = await this.messagingSend({
      conversationId: `group:${groupId}`,
      senderDeviceId: senderDeviceId ?? null,
      receiverDeviceId,
      encryptedPayload: message.ciphertext, // OPAQUE — Layer 8 never inspects it
      priority,
      metadata: { groupId: String(groupId), groupMessageId: message.messageId, keyVersion: message.keyVersion },
    });
    return { messageRef: result?.message?.messageId ?? result?.messageId ?? null, delivered: result?.delivered !== false };
  }

  /** @private set a single leg's state in a persisted plan (bridging PLANNED/QUEUED → DELIVERED via DISPATCHED). */
  async _setLegState(plan, deviceId, toState, patch = {}) {
    const now = this._nowIso();
    const legs = (plan.legs ?? []).map((leg) => {
      if (String(leg.deviceId) !== String(deviceId)) return leg;
      try {
        let cur = leg;
        // A confirmed receipt on a not-yet-dispatched leg (offline device fetched it) advances legally
        // through DISPATCHED first.
        if (toState === GroupDeliveryState.DELIVERED && (cur.state === GroupDeliveryState.PLANNED || cur.state === GroupDeliveryState.QUEUED)) {
          cur = transitionLeg(cur, GroupDeliveryState.DISPATCHED, {}, now);
        }
        return transitionLeg(cur, toState, patch, now);
      } catch {
        return leg; // ignore illegal transition (e.g. already delivered)
      }
    });
    const recomputed = recomputeFanoutStatus({ ...plan, legs });
    return this.fanoutPlans.update(plan.planId, { legs, status: recomputed.status, summary: recomputed.summary });
  }

  /** @private advance a device replica's delivery cursor after a receipt. */
  async _advanceReplicaCursor(groupId, deviceId, memberId, message) {
    let replica = await this.replicas.findByDevice(groupId, deviceId);
    if (!replica) replica = buildCommReplica({ groupId, deviceId, memberId, keyVersion: message.keyVersion, clock: this.clock, idGenerator: this.idGenerator });
    const cursor = { messageId: message.messageId, at: message.createdAt };
    const { replica: updated } = applyReplicaUpdate(replica, replica.facetVersions, { keyVersion: Math.max(replica.keyVersion ?? 0, message.keyVersion), deliveryCursor: cursor, at: this._nowIso() });
    return this.replicas.upsert(updated);
  }

  /** @private bump every group replica's known key version after a rotation. */
  async _refreshGroupReplicas(groupId, keyVersion) {
    const replicas = await this.replicas.listByGroup(groupId);
    for (const r of replicas) {
      if ((r.keyVersion ?? 0) < keyVersion) await this.replicas.update(groupId, r.deviceId, { keyVersion, updatedAt: this._nowIso() });
    }
  }

  /** @private the default in-process messaging hook (loopback) — for device-embedded engines + tests. */
  _defaultMessagingSend() {
    const sent = [];
    const hook = async (envelope) => {
      sent.push(envelope);
      return { message: { messageId: this.idGenerator() }, delivered: true };
    };
    hook.sent = sent;
    return hook;
  }

  async _audit(store, entry) {
    return this.repo[store]?.record?.({ ...entry, at: this._nowIso() });
  }

  /** @private serialize key/replica mutations per group. */
  async _withLock(groupId, fn) {
    const key = String(groupId);
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

/**
 * Adapt a Sprint-1 {@link GroupManager} into the directory contract the engine consumes: active members
 * + group facet versions. Keeps the engine decoupled from the Sprint-1 subsystem's internals.
 * @param {object} groupManager the Sprint-1 GroupManager
 * @returns {{ getActiveMembers: (groupId) => Promise<Array>, getGroupVersions: (groupId) => Promise<object> }}
 */
export function createGroupDirectoryFromManager(groupManager) {
  return {
    async getActiveMembers(groupId) {
      const { members } = await groupManager.listMembers({ groupId, limit: 500 });
      return members.filter((m) => m.counted).map((m) => ({ memberId: m.memberId, role: m.role, state: m.state }));
    },
    async getGroupVersions(groupId) {
      const { versions } = await groupManager.getVersions({ groupId });
      return versions;
    },
  };
}

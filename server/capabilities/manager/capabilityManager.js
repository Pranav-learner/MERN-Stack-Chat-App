/**
 * @module capabilities/manager
 *
 * The **Capability Manager** — the reusable facade for the Capability Exchange subsystem (Layer 6,
 * Sprint 3). It owns the "how can these two devices communicate?" control plane and is the single
 * object future layers consume. Its responsibilities (the sprint spec):
 *
 * - **Register / update / refresh / remove capabilities** for a device.
 * - **Resolve capabilities** — a device's advertised capability set.
 * - **Negotiate capabilities** — deterministically compute what two devices share + which
 *   transport they should PREFER (via the {@link module:capabilities/negotiation engine}).
 * - **Validate compatibility**, **cache results** (version-aware), **track versions**, and
 *   **manage the lifecycle** via the {@link module:capabilities/lifecycle state machine}.
 *
 * @important This subsystem determines COMPATIBILITY + a PREFERRED communication strategy only. It
 * does NOT establish connections, perform NAT traversal, or do any ICE/STUN/TURN/WebRTC work.
 * Future Layer 6/7 sprints consume the negotiation result + these events to actually connect.
 *
 * @security Records, results, DTOs, and events carry PUBLIC data only — versions, transport names,
 * flags, limits — never private keys, session keys, message keys, chain keys, or shared secrets.
 *
 * @example
 * ```js
 * import { CapabilityManager, createInMemoryCapabilityRepository } from "./capabilities/index.js";
 * const caps = new CapabilityManager({ ...createInMemoryCapabilityRepository() });
 * await caps.registerCapabilities({ userId: "u1", deviceId: "d1", transports: ["websocket","relay"] });
 * await caps.registerCapabilities({ userId: "u2", deviceId: "d1", transports: ["relay"] });
 * const { result } = await caps.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
 * result.preferredTransport; // "relay"
 * ```
 */

import crypto from "node:crypto";
import {
  CapabilityState,
  CapabilityEventType,
  CapabilityFailureReason,
  CapabilitySource,
  NegotiationState,
  DEFAULT_CAPABILITY_TTL_MS,
  isNegotiableState,
} from "../types/types.js";
import { CapabilityExpiredError, CapabilityNotFoundError } from "../errors.js";
import { assertCapabilityTransition } from "../lifecycle/lifecycle.js";
import {
  createCapabilityRecord,
  appendVersionHistory,
  isCapabilityExpired,
  capabilityKey,
  toNegotiable,
} from "../record/capabilityRecord.js";
import { createCapabilityAdvertisement } from "../advertisement/advertisement.js";
import { negotiateCapabilities, negotiationKey } from "../negotiation/negotiation.js";
import { resolvePolicy, selectPreferredTransport } from "../policies/transportPolicy.js";
import { CapabilityCache } from "../cache/cache.js";
import { CapabilityEventBus } from "../events/events.js";
import {
  validateCapabilityRequest,
  validateUserRef,
  validateDeviceRef,
  validateCapabilityId,
  requireCapability,
  assertOwner,
  assertNoDuplicateRegistration,
  assertNoSecretMaterial,
  validateCapabilityRepository,
} from "../validators/validators.js";
import {
  toPublicCapabilities,
  toPublicNegotiation,
  toCapabilityStatus,
  toPublicNegotiationRecord,
} from "../serializers/serializer.js";

export class CapabilityManager {
  /**
   * @param {object} deps
   * @param {object} deps.capabilities capability repository (required)
   * @param {object} [deps.negotiations] negotiation-history repository (optional; enables history)
   * @param {CapabilityCache} [deps.cache]
   * @param {CapabilityEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {number} [deps.ttlMs] default capability TTL
   * @param {string|object} [deps.defaultPolicy] default transport-preference policy
   */
  constructor(deps) {
    if (!deps || !deps.capabilities) throw new Error("CapabilityManager requires { capabilities }");
    this.capabilities = validateCapabilityRepository(deps.capabilities);
    this.negotiations = deps.negotiations ?? null;
    this.events = deps.events ?? new CapabilityEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.ttlMs = deps.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.defaultPolicy = deps.defaultPolicy;
    this.cache = deps.cache ?? new CapabilityCache({ clock: this.clock });
  }

  // === registration + updates =============================================

  /**
   * Register (or replace) a device's capability set, then advertise it. If a LIVE set already
   * exists for the device this is a duplicate registration and throws; an expired/removed set is
   * replaced. Emits `REGISTERED` + `ADVERTISED`. @returns {Promise<object>} public DTO.
   * @param {object} request capability-advertisement fields + `{ userId, deviceId, identityId?, ttlMs?, metadata? }`
   */
  async registerCapabilities(request) {
    validateCapabilityRequest(request);
    const existing = await this.capabilities.findByUserAndDevice(request.userId, request.deviceId);
    assertNoDuplicateRegistration(existing, existing ? isNegotiableState(existing.state) : false);

    const record = createCapabilityRecord({
      ...request,
      ttlMs: request.ttlMs ?? this.ttlMs,
      // Reuse the prior capabilityId when replacing an expired set (id stability for history).
      capabilityId: existing?.capabilityId,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    assertNoSecretMaterial(record, "capability set");
    const stored = await this.capabilities.upsert(record);
    this.events.emit(CapabilityEventType.REGISTERED, this._eventFor(stored));
    const advertised = await this._transition(stored, CapabilityState.ADVERTISED, { reason: "advertise", event: CapabilityEventType.ADVERTISED });
    this._invalidate(advertised);
    return toPublicCapabilities(advertised);
  }

  /**
   * Update a device's capabilities (merges new advertisement fields, bumps the version). Owner-
   * scoped. Emits `UPDATED`. The version bump makes any cached negotiation for this device stale.
   * @param {string} capabilityId
   * @param {{ actingUser?: string, ttlMs?: number, ...capabilityFields }} options
   * @returns {Promise<object>} public DTO
   */
  async updateCapabilities(capabilityId, options = {}) {
    const record = await this._require(capabilityId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    // Re-normalize the merged advertisement so partial updates stay well-formed + extensible.
    const merged = createCapabilityAdvertisement({
      protocolVersions: options.protocolVersions ?? record.protocolVersions,
      cryptoVersions: options.cryptoVersions ?? record.cryptoVersions,
      transports: options.transports ?? record.transports,
      compression: options.compression ?? record.compression,
      attachments: options.attachments ?? record.attachments,
      maxPayloadSize: options.maxPayloadSize ?? record.maxPayloadSize,
      relaySupport: options.relaySupport ?? record.relaySupport,
      connectionPreferences: options.connectionPreferences ?? record.connectionPreferences,
      platformFeatures: options.platformFeatures ?? record.platformFeatures,
      softwareVersion: options.softwareVersion ?? record.softwareVersion,
      featureFlags: options.featureFlags ?? record.featureFlags,
      metadata: options.metadata ?? record.metadata,
    });
    const at = this._nowIso();
    const version = (record.version ?? 0) + 1;
    const patch = {
      ...merged,
      version,
      versionHistory: appendVersionHistory(record.versionHistory, { version, at, reason: options.reason ?? "updated" }),
      expiresAt: this._expiryFrom(at, options.ttlMs),
    };
    assertNoSecretMaterial(patch, "capability set");
    // Keep it advertised (a fresh update re-advertises); revive an expired set.
    const updated = await this._transition({ ...record }, CapabilityState.ADVERTISED, { reason: "updated", patch, event: CapabilityEventType.UPDATED });
    this._invalidate(updated);
    return toPublicCapabilities(updated);
  }

  /**
   * Refresh a capability set's TTL (liveness) without changing its capabilities. Revives an expired
   * set. Emits `REFRESHED`. Owner-scoped when `actingUser` is given. @returns {Promise<object>}
   * @param {string} capabilityId @param {{ actingUser?: string, ttlMs?: number }} [options]
   */
  async refreshCapabilities(capabilityId, options = {}) {
    const record = await this._require(capabilityId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const at = this._nowIso();
    const updated = await this._transition(record, CapabilityState.ADVERTISED, {
      reason: "refreshed",
      patch: { expiresAt: this._expiryFrom(at, options.ttlMs) },
      event: CapabilityEventType.REFRESHED,
    });
    this._invalidate(updated);
    return toPublicCapabilities(updated);
  }

  /**
   * Remove a device's capability set. Emits `REMOVED`. Owner-scoped when `actingUser` is given.
   * @param {string} capabilityId @param {{ actingUser?: string }} [options]
   * @returns {Promise<{ capabilityId: string, removed: boolean }>}
   */
  async removeCapabilities(capabilityId, options = {}) {
    const record = await this._require(capabilityId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const removed = await this.capabilities.delete(capabilityId);
    this.events.emit(CapabilityEventType.REMOVED, this._eventFor(record));
    this._invalidate(record);
    return { capabilityId: String(capabilityId), removed };
  }

  // === queries + resolution ===============================================

  /** A device's capability set by id (public DTO). Lazily expires it on read. Owner-scoped optionally. */
  async getCapabilities(capabilityId, options = {}) {
    const record = await this._require(capabilityId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const current = (await this._sweepIfExpired(record)) ?? record;
    return toPublicCapabilities(current, { includeHistory: options.includeHistory });
  }

  /** A device's capability set by (userId, deviceId) (public DTO). */
  async getDeviceCapabilities(userId, deviceId) {
    const record = await this._requireDevice(userId, deviceId);
    const current = (await this._sweepIfExpired(record)) ?? record;
    return toPublicCapabilities(current);
  }

  /** Compact capability status (for polling). */
  async getCapabilityStatus(capabilityId) {
    const record = await this._require(capabilityId);
    const current = (await this._sweepIfExpired(record)) ?? record;
    return toCapabilityStatus(current);
  }

  /**
   * Resolve a device's negotiable capability set (raw fields). Throws if unknown or expired.
   * @param {string} userId @param {string} deviceId @returns {Promise<object>}
   */
  async resolveCapabilities(userId, deviceId) {
    const record = await this._requireDevice(userId, deviceId);
    const current = (await this._sweepIfExpired(record)) ?? record;
    if (!isNegotiableState(current.state)) {
      throw new CapabilityExpiredError(`Capabilities for ${userId}/${deviceId} are not available (state: ${current.state})`, {
        details: { userId: String(userId), deviceId: String(deviceId), state: current.state },
      });
    }
    return toNegotiable(current);
  }

  /** All of a user's capability sets. */
  async listUserCapabilities(userId) {
    validateUserRef(userId);
    return (await this.capabilities.findByUser(String(userId))).map((r) => toPublicCapabilities(r));
  }

  // === negotiation =========================================================

  /**
   * Negotiate how two devices can communicate. Resolves both capability sets, runs the
   * deterministic engine (through a version-aware cache), records the outcome, and emits events.
   * Returns a compatibility + preferred-transport PLAN — never a connection.
   *
   * @param {{ requester: string, requesterDevice: string, targetUser: string, targetDevice: string, policy?: string|object }} request
   * @returns {Promise<{ result: object, source: string, negotiationId: string|null }>}
   */
  async negotiate(request) {
    const { requester, requesterDevice, targetUser, targetDevice } = request;
    const [localCaps, remoteCaps] = await Promise.all([
      this.resolveCapabilities(requester, requesterDevice),
      this.resolveCapabilities(targetUser, targetDevice),
    ]);
    const policy = resolvePolicy(request.policy ?? this.defaultPolicy);
    const key = negotiationKey(localCaps, remoteCaps, policy.name);
    const devices = [`${requester}:${requesterDevice}`, `${targetUser}:${targetDevice}`];

    this.events.emit(CapabilityEventType.NEGOTIATION_STARTED, { requester, requesterDevice, targetUser, targetDevice, policy: policy.name });

    // Version-aware cache: a capability update mints a new key, so a hit is always current.
    const probe = this.cache.get(key);
    if (probe.outcome === "hit") return { result: toPublicNegotiation(probe.value), source: CapabilitySource.CACHE, negotiationId: null };
    if (probe.outcome === "negative") {
      const negative = { compatible: false, failureReason: CapabilityFailureReason.NO_SHARED_TRANSPORT };
      return { result: toPublicNegotiation({ ...negative, sharedTransports: [], fallbackChain: [], featureFlags: {}, policy: policy.name }), source: CapabilitySource.NEGATIVE_CACHE, negotiationId: null };
    }

    const result = negotiateCapabilities(localCaps, remoteCaps, { policy });

    if (result.compatible) {
      this.cache.set(key, result, devices);
      this.events.emit(CapabilityEventType.NEGOTIATION_SUCCEEDED, { requester, requesterDevice, targetUser, targetDevice, result: toPublicNegotiation(result) });
      if (result.preferredTransport) {
        this.events.emit(CapabilityEventType.PREFERRED_TRANSPORT_SELECTED, { requester, requesterDevice, targetUser, targetDevice, preferredTransport: result.preferredTransport, fallbackChain: result.fallbackChain });
      }
    } else {
      this.cache.setNegative(key, devices);
      this.events.emit(CapabilityEventType.NEGOTIATION_FAILED, { requester, requesterDevice, targetUser, targetDevice, reason: result.failureReason });
    }

    const negotiationId = await this._recordNegotiation(request, result);
    return { result: toPublicNegotiation(result), source: CapabilitySource.COMPUTED, negotiationId };
  }

  /**
   * Resolve just the PREFERRED transport (+ fallback chain) for two devices under a policy — a
   * convenience over {@link negotiate} for callers that only need the transport plan.
   * @param {{ requester: string, requesterDevice: string, targetUser: string, targetDevice: string, policy?: string|object }} request
   * @returns {Promise<{ compatible: boolean, preferredTransport: string|null, fallbackChain: string[], sharedTransports: string[], policy: string, failureReason: string|null }>}
   */
  async resolvePreferredTransport(request) {
    const { result } = await this.negotiate(request);
    return {
      compatible: result.compatible,
      preferredTransport: result.preferredTransport,
      fallbackChain: result.fallbackChain,
      sharedTransports: result.sharedTransports,
      policy: result.policy,
      failureReason: result.failureReason,
    };
  }

  /** Negotiation history for a device (most recent first). */
  async getNegotiationHistory(userId, deviceId, options = {}) {
    validateUserRef(userId);
    validateDeviceRef(deviceId);
    if (!this.negotiations) return [];
    const list = await this.negotiations.listByDevice(String(userId), String(deviceId), { limit: options.limit });
    return list.map(toPublicNegotiationRecord);
  }

  /** Negotiation history between a specific device pair. */
  async getPairHistory(userId, deviceId, targetUser, targetDevice, options = {}) {
    if (!this.negotiations) return [];
    const list = await this.negotiations.listByPair(String(userId), String(deviceId), String(targetUser), String(targetDevice), { limit: options.limit });
    return list.map(toPublicNegotiationRecord);
  }

  // === lifecycle sweeps + stats ===========================================

  /**
   * Sweep capability sets past their TTL to `EXPIRED`. Emits `EXPIRED`. Idempotent under
   * concurrency. @param {number} [now] @returns {Promise<{ expired: number, cachePruned: number }>}
   */
  async sweepExpired(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const stale = await this.capabilities.listExpired(nowIso);
    let expired = 0;
    for (const record of stale) {
      try {
        await this._transition(record, CapabilityState.EXPIRED, { reason: "ttl-elapsed", event: CapabilityEventType.EXPIRED });
        this._invalidate(record);
        expired++;
      } catch {
        // A concurrent transition may have already moved it; ignore.
      }
    }
    const cachePruned = this.cache.pruneExpired(now);
    return { expired, cachePruned };
  }

  /** Counts of capability sets by state. */
  async countByState() {
    return this.capabilities.countByState();
  }

  /** Negotiation-cache statistics snapshot. */
  cacheStats() {
    return this.cache.stats();
  }

  // === internals ==========================================================

  /** @private Load + require a set by capabilityId (validated). */
  async _require(capabilityId) {
    validateCapabilityId(capabilityId);
    return requireCapability(await this.capabilities.findById(capabilityId), capabilityId);
  }

  /** @private Load + require a set by (userId, deviceId) (validated). */
  async _requireDevice(userId, deviceId) {
    validateUserRef(userId);
    validateDeviceRef(deviceId);
    return requireCapability(await this.capabilities.findByUserAndDevice(String(userId), String(deviceId)), `${userId}|${deviceId}`);
  }

  /**
   * @private Guarded transition: validate legality, patch state + version bookkeeping, persist,
   * emit. @returns {Promise<object>} the updated record
   */
  async _transition(record, toState, options = {}) {
    assertCapabilityTransition(record.state, toState);
    const at = this._nowIso();
    const patch = { state: toState, updatedAt: at, ...(options.patch ?? {}) };
    if (patch.advertisement) assertNoSecretMaterial(patch, "capability set");
    const updated = await this.capabilities.update(record.capabilityId, patch);
    if (options.event) this.events.emit(options.event, this._eventFor(updated, { previousState: record.state, reason: options.reason }));
    return updated;
  }

  /**
   * @private Lazily move a live-but-expired set to EXPIRED on read.
   * @returns {Promise<object|null>} the updated record, or null if no sweep occurred.
   */
  async _sweepIfExpired(record) {
    if (isNegotiableState(record.state) && isCapabilityExpired(record, this.clock())) {
      const updated = await this._transition(record, CapabilityState.EXPIRED, { reason: "ttl-elapsed", event: CapabilityEventType.EXPIRED });
      this._invalidate(updated);
      return updated;
    }
    return null;
  }

  /** @private Record a negotiation outcome in history (when a negotiations repo is present). */
  async _recordNegotiation(request, result) {
    if (!this.negotiations) return null;
    const negotiation = {
      negotiationId: this.idGenerator(),
      requester: String(request.requester),
      requesterDevice: String(request.requesterDevice),
      targetUser: String(request.targetUser),
      targetDevice: String(request.targetDevice),
      state: result.compatible ? NegotiationState.SUCCEEDED : NegotiationState.FAILED,
      result,
      createdAt: this._nowIso(),
      schemaVersion: result.schemaVersion,
    };
    const stored = await this.negotiations.record(negotiation);
    return stored.negotiationId;
  }

  /** @private Invalidate cached negotiations touching a record's device. */
  _invalidate(record) {
    const removed = this.cache.invalidateDevice(`${record.userId}:${record.deviceId}`);
    if (removed > 0) this.events.emit(CapabilityEventType.CACHE_INVALIDATED, { userId: record.userId, deviceId: record.deviceId, removed });
  }

  /** @private Build a standard event payload from a record. */
  _eventFor(record, extras = {}) {
    return {
      capabilityId: record.capabilityId,
      userId: record.userId,
      deviceId: record.deviceId,
      state: record.state,
      version: record.version,
      ...extras,
    };
  }

  /** @private */
  _expiryFrom(atIso, ttlMs) {
    return new Date(new Date(atIso).getTime() + (ttlMs ?? this.ttlMs)).toISOString();
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

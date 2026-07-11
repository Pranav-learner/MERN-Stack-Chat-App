/**
 * @module presence/manager
 *
 * The **Presence Manager** — the reusable facade for the Presence Service (Layer 6, Sprint 2).
 * It owns the real-time availability control plane and is the single object future layers
 * consume. Its responsibilities (the sprint spec):
 *
 * - **Register / update / remove presence** for a device.
 * - **Heartbeat** — refresh a device's liveness (and recover it if it had dropped).
 * - **Lookup presence** — a device's record, and **resolve a user's reachable devices**.
 * - **Cache** resolved presence views (via the {@link module:presence/cache cache}).
 * - **Validate** every request (ownership, status, transitions, no-secret invariant).
 * - **Manage the lifecycle** via the {@link module:presence/lifecycle state machine}, and sweep
 *   heartbeat-expired devices to `EXPIRED`.
 *
 * @important This sprint answers *whether* a device is reachable — NOT *how* to reach it. It
 * performs NO capability exchange, NAT traversal, ICE/STUN/TURN, WebRTC, QUIC/TCP, or P2P.
 * Future Layer 6 sprints consume this manager + its events to build those.
 *
 * @security Records, advertisements, DTOs, and events carry PUBLIC data only — public identity
 * keys + fingerprints, ids, statuses, timestamps, counts — never private keys, session keys,
 * message keys, chain keys, or shared secrets.
 *
 * @distributed The manager is stateless beyond its repository + cache, so it scales
 * horizontally: run many instances behind a shared store. The cache is process-local and
 * swappable for Redis; heartbeat sweeps are idempotent (a concurrent sweep that already moved a
 * record is ignored), so multiple instances can sweep safely.
 *
 * @example
 * ```js
 * import { PresenceManager, createInMemoryPresenceRepository } from "./presence/index.js";
 * const presence = new PresenceManager({ ...createInMemoryPresenceRepository() });
 * const rec = await presence.registerPresence({ userId: "u1", deviceId: "d1", status: "online" });
 * await presence.heartbeat(rec.presenceId);
 * const { devices } = await presence.resolveActiveDevices("u1"); // reachable device advertisements
 * ```
 */

import crypto from "node:crypto";
import {
  PresenceStatus,
  PresenceEventType,
  PresenceFailureReason,
  PresenceSource,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  isReachableStatus,
  isVisibleOnlineStatus,
} from "../types/types.js";
import { PresenceError } from "../errors.js";
import { assertPresenceTransition } from "../lifecycle/lifecycle.js";
import {
  createPresenceRecord,
  appendStatusHistory,
  isPresenceExpired,
} from "../record/presenceRecord.js";
import { restampAdvertisement, createDeviceAdvertisement } from "../advertisement/advertisement.js";
import { PresenceCache } from "../cache/cache.js";
import { PresenceEventBus } from "../events/events.js";
import {
  validateRegistrationRequest,
  validateUserRef,
  validateDeviceRef,
  validatePresenceId,
  validateUserSettableStatus,
  requirePresence,
  assertOwner,
  assertNoDuplicateRegistration,
  assertNoSecretMaterial,
  validatePresenceRepository,
} from "../validators/validators.js";
import {
  toPublicPresence,
  toPublicAdvertisement,
  toPresenceStatus,
  toLastSeen,
} from "../serializers/serializer.js";

export class PresenceManager {
  /**
   * @param {object} deps
   * @param {object} deps.presence presence repository (required)
   * @param {PresenceCache} [deps.cache]
   * @param {PresenceEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {number} [deps.heartbeatTimeoutMs] default heartbeat timeout window
   */
  constructor(deps) {
    if (!deps || !deps.presence) throw new Error("PresenceManager requires { presence }");
    this.presence = validatePresenceRepository(deps.presence);
    this.events = deps.events ?? new PresenceEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.cache = deps.cache ?? new PresenceCache({ clock: this.clock });
  }

  // === registration ========================================================

  /**
   * Register (or revive) a device's presence. If the device is already registered AND
   * reachable, this is a duplicate registration and throws; if it exists but is offline /
   * disconnected / expired, it is **revived** (a fresh advertisement + heartbeat window).
   * Emits `REGISTERED`, `DEVICE_ADVERTISED`, and (derived) `ONLINE`.
   *
   * @param {{ userId: string, deviceId: string, identityId?: string, identity?: object|null,
   *   status?: string, softwareVersion?: string, platform?: string, timeoutMs?: number, metadata?: object }} request
   * @returns {Promise<object>} the public presence DTO
   */
  async registerPresence(request) {
    validateRegistrationRequest(request);
    const status = request.status ?? PresenceStatus.ONLINE;
    const existing = await this.presence.findByUserAndDevice(request.userId, request.deviceId);
    assertNoDuplicateRegistration(existing, existing ? isReachableStatus(existing.status) : false);

    if (existing) {
      // Revive a non-reachable record in place (keep presenceId + registeredAt + history).
      const at = this._nowIso();
      const advertisement = createDeviceAdvertisement({
        userId: existing.userId,
        deviceId: existing.deviceId,
        identityId: request.identityId ?? existing.identityId,
        identity: request.identity ?? null,
        status,
        softwareVersion: request.softwareVersion ?? existing.advertisement?.softwareVersion,
        platform: request.platform ?? existing.advertisement?.platform,
        at,
        metadata: request.metadata ?? existing.advertisement?.metadata,
        version: (existing.advertisement?.version ?? 1) + 1,
      });
      assertNoSecretMaterial(advertisement, "device advertisement");
      const revived = await this._transition(existing, status, {
        reason: "re-registered",
        patch: {
          advertisement,
          lastSeen: at,
          heartbeatAt: at,
          expiresAt: this._expiryFrom(at, request.timeoutMs),
          missedHeartbeats: 0,
          identityId: request.identityId ?? existing.identityId,
          metadata: request.metadata ?? existing.metadata,
        },
        event: PresenceEventType.REGISTERED,
      });
      this.events.emit(PresenceEventType.DEVICE_ADVERTISED, { presenceId: revived.presenceId, userId: revived.userId, deviceId: revived.deviceId, advertisement: toPublicAdvertisement(revived.advertisement) });
      this._invalidate(revived.userId);
      return toPublicPresence(revived);
    }

    // Fresh record.
    const record = createPresenceRecord({
      ...request,
      status,
      timeoutMs: request.timeoutMs ?? this.heartbeatTimeoutMs,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    assertNoSecretMaterial(record, "presence record");
    const stored = await this.presence.create(record);
    this.events.emit(PresenceEventType.REGISTERED, this._eventFor(stored, { previousStatus: null }));
    this.events.emit(PresenceEventType.DEVICE_ADVERTISED, { presenceId: stored.presenceId, userId: stored.userId, deviceId: stored.deviceId, advertisement: toPublicAdvertisement(stored.advertisement) });
    if (isVisibleOnlineStatus(stored.status)) this.events.emit(PresenceEventType.ONLINE, this._eventFor(stored, { previousStatus: null }));
    this._invalidate(stored.userId);
    return toPublicPresence(stored);
  }

  // === updates =============================================================

  /**
   * Update a device's user-settable status (online / away / busy / invisible). Owner-scoped.
   * Emits `UPDATED` (+ derived `ONLINE`/`OFFLINE`). @returns {Promise<object>} public DTO.
   * @param {string} presenceId
   * @param {{ status: string, actingUser?: string, metadata?: object, softwareVersion?: string, platform?: string }} options
   */
  async updatePresence(presenceId, options) {
    const record = await this._require(presenceId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    validateUserSettableStatus(options.status);
    const at = this._nowIso();
    const advertisement = restampAdvertisement(record.advertisement, options.status, at);
    if (options.softwareVersion !== undefined) advertisement.softwareVersion = options.softwareVersion;
    if (options.platform !== undefined) advertisement.platform = options.platform;
    if (options.metadata !== undefined && advertisement) advertisement.metadata = options.metadata;
    const updated = await this._transition(record, options.status, {
      reason: "status-update",
      patch: { advertisement, lastSeen: at, ...(options.metadata !== undefined ? { metadata: options.metadata } : {}) },
      event: PresenceEventType.UPDATED,
    });
    this._invalidate(updated.userId);
    return toPublicPresence(updated);
  }

  /** Update a device's status by (userId, deviceId). @returns {Promise<object>} */
  async setDeviceStatus(userId, deviceId, status, options = {}) {
    const record = await this._requireDevice(userId, deviceId);
    return this.updatePresence(record.presenceId, { ...options, status });
  }

  // === heartbeat ===========================================================

  /**
   * Record a heartbeat: refresh liveness + push out the expiry. If the device had dropped
   * (disconnected / reconnecting / expired / offline), the heartbeat **recovers** it back to
   * `ONLINE` and emits `RECOVERED`. Emits `HEARTBEAT_RECEIVED`. Owner-scoped when `actingUser`
   * is given. @returns {Promise<object>} public DTO.
   * @param {string} presenceId
   * @param {{ actingUser?: string, timeoutMs?: number }} [options]
   */
  async heartbeat(presenceId, options = {}) {
    const record = await this._require(presenceId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const at = this._nowIso();
    const basePatch = {
      lastSeen: at,
      heartbeatAt: at,
      expiresAt: this._expiryFrom(at, options.timeoutMs),
      missedHeartbeats: 0,
    };

    const recovering = !isReachableStatus(record.status); // disconnected/reconnecting/expired/offline/unknown
    let updated;
    if (recovering) {
      const advertisement = restampAdvertisement(record.advertisement, PresenceStatus.ONLINE, at);
      updated = await this._transition(record, PresenceStatus.ONLINE, {
        reason: "heartbeat-recovery",
        patch: { ...basePatch, advertisement },
        event: PresenceEventType.RECOVERED,
      });
    } else {
      // Reachable → keep status; just refresh the heartbeat window (a self-transition).
      updated = await this._transition(record, record.status, {
        reason: "heartbeat",
        patch: basePatch,
        event: null,
        silentHistory: true, // don't spam status history with identical-status beats
      });
    }
    this.events.emit(PresenceEventType.HEARTBEAT_RECEIVED, this._eventFor(updated, { recovered: recovering }));
    if (recovering) this._invalidate(updated.userId);
    return toPublicPresence(updated);
  }

  /** Heartbeat by (userId, deviceId). @returns {Promise<object>} */
  async heartbeatDevice(userId, deviceId, options = {}) {
    const record = await this._requireDevice(userId, deviceId);
    return this.heartbeat(record.presenceId, options);
  }

  // === offline / disconnect / remove =======================================

  /**
   * Mark a device cleanly OFFLINE (a deliberate sign-off). Emits `OFFLINE`. Owner-scoped when
   * `actingUser` is given. @returns {Promise<object>} public DTO.
   * @param {string} presenceId @param {{ actingUser?: string, reason?: string }} [options]
   */
  async markOffline(presenceId, options = {}) {
    const record = await this._require(presenceId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const updated = await this._transition(record, PresenceStatus.OFFLINE, {
      reason: options.reason ?? "signed-off",
      patch: { advertisement: restampAdvertisement(record.advertisement, PresenceStatus.OFFLINE, this._nowIso()) },
      event: PresenceEventType.UPDATED,
    });
    this._invalidate(updated.userId);
    return toPublicPresence(updated);
  }

  /**
   * Mark a device DISCONNECTED (an unclean connection loss — e.g. a socket dropped). Emits
   * `OFFLINE`. @returns {Promise<object>} public DTO.
   * @param {string} presenceId @param {{ reason?: string }} [options]
   */
  async markDisconnected(presenceId, options = {}) {
    const record = await this._require(presenceId);
    const updated = await this._transition(record, PresenceStatus.DISCONNECTED, {
      reason: options.reason ?? "connection-lost",
      patch: { advertisement: restampAdvertisement(record.advertisement, PresenceStatus.DISCONNECTED, this._nowIso()) },
      event: PresenceEventType.UPDATED,
    });
    this._invalidate(updated.userId);
    return toPublicPresence(updated);
  }

  /** Mark a device DISCONNECTED by (userId, deviceId) — returns null if no record. */
  async markDeviceDisconnected(userId, deviceId, options = {}) {
    const record = await this.presence.findByUserAndDevice(userId, deviceId);
    if (!record) return null;
    return this.markDisconnected(record.presenceId, options);
  }

  /**
   * Remove a device's presence record entirely. Emits `REMOVED`. Owner-scoped when `actingUser`
   * is given. @param {string} presenceId @param {{ actingUser?: string }} [options]
   * @returns {Promise<{ presenceId: string, removed: boolean }>}
   */
  async removePresence(presenceId, options = {}) {
    const record = await this._require(presenceId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const removed = await this.presence.delete(presenceId);
    this.events.emit(PresenceEventType.REMOVED, this._eventFor(record, {}));
    this._invalidate(record.userId);
    return { presenceId: String(presenceId), removed };
  }

  // === queries =============================================================

  /** A device's presence record (public DTO). Lazily expires it on read. Owner-scoped optionally. */
  async getPresence(presenceId, options = {}) {
    const record = await this._require(presenceId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    const current = (await this._sweepIfExpired(record)) ?? record;
    return toPublicPresence(current, { includeHistory: options.includeHistory });
  }

  /** A device's presence by (userId, deviceId) (public DTO). */
  async getDevicePresence(userId, deviceId) {
    const record = await this._requireDevice(userId, deviceId);
    const current = (await this._sweepIfExpired(record)) ?? record;
    return toPublicPresence(current);
  }

  /** Compact status of a device's presence (for polling). */
  async getPresenceStatus(presenceId) {
    const record = await this._require(presenceId);
    const current = (await this._sweepIfExpired(record)) ?? record;
    return toPresenceStatus(current);
  }

  /**
   * Resolve a user's currently-reachable device advertisements — the core "which devices are
   * reachable?" answer. Reads through the cache; negative-caches an empty result.
   * @param {string} userId @returns {Promise<{ userId: string, devices: object[], source: string }>}
   */
  async lookupUserPresence(userId) {
    validateUserRef(userId);
    const uid = String(userId);
    const probe = this.cache.get(uid);
    if (probe.outcome === "hit") return { userId: uid, devices: probe.value, source: PresenceSource.CACHE };
    if (probe.outcome === "negative") return { userId: uid, devices: [], source: PresenceSource.NEGATIVE_CACHE };

    const records = await this.presence.listReachableByUser(uid);
    const devices = records.map((r) => toPublicAdvertisement(r.advertisement)).filter(Boolean);
    if (devices.length === 0) {
      this.cache.setNegative(uid);
      return { userId: uid, devices: [], source: PresenceSource.REPOSITORY };
    }
    this.cache.set(uid, devices);
    return { userId: uid, devices, source: PresenceSource.REPOSITORY };
  }

  /** Alias for {@link lookupUserPresence} → just the reachable device advertisements. */
  async resolveActiveDevices(userId) {
    return this.lookupUserPresence(userId);
  }

  /**
   * List a user's VISIBLE-online devices (excludes `invisible`). @param {string} userId
   * @returns {Promise<object[]>} compact presence status views
   */
  async listOnline(userId) {
    validateUserRef(userId);
    const records = await this.presence.listReachableByUser(String(userId));
    return records.filter((r) => isVisibleOnlineStatus(r.status)).map(toPresenceStatus);
  }

  /** All of a user's presence records (every device, any status). */
  async listUserDevices(userId) {
    validateUserRef(userId);
    return (await this.presence.findByUser(String(userId))).map((r) => toPublicPresence(r));
  }

  /** A device's last-seen view. */
  async getLastSeen(userId, deviceId) {
    const record = await this._requireDevice(userId, deviceId);
    return toLastSeen(record);
  }

  /** A device's status history (owner-scoped optionally). */
  async getHistory(presenceId, options = {}) {
    const record = await this._require(presenceId);
    if (options.actingUser) assertOwner(record, options.actingUser);
    return (record.statusHistory ?? []).map((h) => ({ ...h }));
  }

  /** Counts of records by status (observability). */
  async countByStatus() {
    return this.presence.countByStatus();
  }

  /** Presence-cache statistics snapshot. */
  cacheStats() {
    return this.cache.stats();
  }

  // === lifecycle sweeps ====================================================

  /**
   * Sweep heartbeat-expired devices to `EXPIRED`. This is the failure-detection heart of the
   * heartbeat system: any reachable/transitional record whose `expiresAt` has passed is missed.
   * Emits `HEARTBEAT_MISSED` + `EXPIRED` (+ derived `OFFLINE`). Idempotent under concurrency.
   * @param {number} [now] @returns {Promise<{ expired: number, cachePruned: number }>}
   */
  async sweepExpired(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const stale = await this.presence.listExpired(nowIso);
    const invalidatedUsers = new Set();
    let expired = 0;
    for (const record of stale) {
      try {
        this.events.emit(PresenceEventType.HEARTBEAT_MISSED, this._eventFor(record, { missedHeartbeats: (record.missedHeartbeats ?? 0) + 1 }));
        await this._transition(record, PresenceStatus.EXPIRED, {
          reason: "heartbeat-timeout",
          patch: {
            missedHeartbeats: (record.missedHeartbeats ?? 0) + 1,
            advertisement: restampAdvertisement(record.advertisement, PresenceStatus.EXPIRED, nowIso),
          },
          event: PresenceEventType.EXPIRED,
        });
        invalidatedUsers.add(record.userId);
        expired++;
      } catch {
        // A concurrent sweep/heartbeat may have already moved it; ignore.
      }
    }
    for (const uid of invalidatedUsers) this._invalidate(uid);
    const cachePruned = this.cache.pruneExpired(now);
    return { expired, cachePruned };
  }

  // === internals ==========================================================

  /** @private Load + require a record by presenceId (validated). */
  async _require(presenceId) {
    validatePresenceId(presenceId);
    return requirePresence(await this.presence.findById(presenceId), presenceId);
  }

  /** @private Load + require a record by (userId, deviceId) (validated). */
  async _requireDevice(userId, deviceId) {
    validateUserRef(userId);
    validateDeviceRef(deviceId);
    return requirePresence(await this.presence.findByUserAndDevice(String(userId), String(deviceId)), `${userId}|${deviceId}`);
  }

  /**
   * @private Guarded transition: validate legality, append history (unless silent), bump
   * version, persist, and emit the primary event plus derived ONLINE/OFFLINE.
   * @returns {Promise<object>} the updated record
   */
  async _transition(record, toStatus, options = {}) {
    assertPresenceTransition(record.status, toStatus);
    const at = this._nowIso();
    const patch = {
      status: toStatus,
      version: (record.version ?? 0) + 1,
      updatedAt: at,
      ...(options.patch ?? {}),
    };
    if (!options.silentHistory || record.status !== toStatus) {
      patch.statusHistory = appendStatusHistory(record.statusHistory, { from: record.status, to: toStatus, at, reason: options.reason });
    }
    if (patch.advertisement) assertNoSecretMaterial(patch.advertisement, "device advertisement");
    const updated = await this.presence.update(record.presenceId, patch);

    const wasOnline = isVisibleOnlineStatus(record.status);
    const wasReachable = isReachableStatus(record.status);
    const nowOnline = isVisibleOnlineStatus(updated.status);
    const nowReachable = isReachableStatus(updated.status);

    if (options.event) this.events.emit(options.event, this._eventFor(updated, { previousStatus: record.status, reason: options.reason }));
    // Derived transitions so consumers can subscribe to just ONLINE / OFFLINE.
    if (!wasOnline && nowOnline && options.event !== PresenceEventType.ONLINE) {
      this.events.emit(PresenceEventType.ONLINE, this._eventFor(updated, { previousStatus: record.status }));
    }
    if (wasReachable && !nowReachable) {
      this.events.emit(PresenceEventType.OFFLINE, this._eventFor(updated, { previousStatus: record.status, reason: options.reason }));
    }
    return updated;
  }

  /**
   * @private Lazily move a reachable/transitional-but-expired record to EXPIRED on read.
   * @returns {Promise<object|null>} the updated record, or null if no sweep occurred.
   */
  async _sweepIfExpired(record) {
    const sweepable = isReachableStatus(record.status) || record.status === PresenceStatus.RECONNECTING || record.status === PresenceStatus.DISCONNECTED;
    if (sweepable && isPresenceExpired(record, this.clock())) {
      const nowIso = this._nowIso();
      this.events.emit(PresenceEventType.HEARTBEAT_MISSED, this._eventFor(record, { missedHeartbeats: (record.missedHeartbeats ?? 0) + 1 }));
      const updated = await this._transition(record, PresenceStatus.EXPIRED, {
        reason: "heartbeat-timeout",
        patch: {
          missedHeartbeats: (record.missedHeartbeats ?? 0) + 1,
          advertisement: restampAdvertisement(record.advertisement, PresenceStatus.EXPIRED, nowIso),
        },
        event: PresenceEventType.EXPIRED,
      });
      this._invalidate(updated.userId);
      return updated;
    }
    return null;
  }

  /** @private Invalidate a user's cached presence view + emit CACHE_INVALIDATED. */
  _invalidate(userId) {
    if (this.cache.invalidateUser(userId)) {
      this.events.emit(PresenceEventType.CACHE_INVALIDATED, { userId: String(userId) });
    }
  }

  /** @private Build a standard event payload from a record. */
  _eventFor(record, extras = {}) {
    return {
      presenceId: record.presenceId,
      userId: record.userId,
      deviceId: record.deviceId,
      status: record.status,
      ...extras,
    };
  }

  /** @private */
  _expiryFrom(atIso, timeoutMs) {
    return new Date(new Date(atIso).getTime() + (timeoutMs ?? this.heartbeatTimeoutMs)).toISOString();
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** @internal exported for the failure-reason mapping used by bindings. */
export function presenceFailureReasonFor(error) {
  if (error instanceof PresenceError) {
    switch (error.code) {
      case "ERR_PRESENCE_DUPLICATE":
        return PresenceFailureReason.DUPLICATE_REGISTRATION;
      case "ERR_PRESENCE_NOT_FOUND":
        return PresenceFailureReason.UNKNOWN_PRESENCE;
      case "ERR_PRESENCE_EXPIRED":
        return PresenceFailureReason.EXPIRED;
      case "ERR_PRESENCE_INVALID_TRANSITION":
        return PresenceFailureReason.INVALID_TRANSITION;
      case "ERR_PRESENCE_UNAUTHORIZED":
        return PresenceFailureReason.UNAUTHORIZED_UPDATE;
      case "ERR_PRESENCE_CORRUPTED":
        return PresenceFailureReason.CORRUPTED_ADVERTISEMENT;
      default:
        return PresenceFailureReason.MALFORMED_METADATA;
    }
  }
  return PresenceFailureReason.INTERNAL_ERROR;
}

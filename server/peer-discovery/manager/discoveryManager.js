/**
 * @module peer-discovery/manager
 *
 * The **Discovery Manager** — the reusable facade for the Peer Discovery Framework
 * (Layer 6, Sprint 1). It owns the networking control plane and is the single object
 * future layers consume. Its responsibilities (the sprint spec):
 *
 * - **Register / deregister device** (via the {@link module:peer-discovery/registry registry})
 * - **Lookup device / lookup user / resolve devices**
 * - **Resolve discovery metadata**
 * - **Cache discovery results** (via the {@link module:peer-discovery/cache cache})
 * - **Validate discovery requests**
 * - **Manage the discovery lifecycle** (create → search → resolve → complete, or fail /
 *   cancel / expire) via the {@link module:peer-discovery/lifecycle state machine}.
 *
 * Every lookup creates a {@link module:peer-discovery/session discovery session}. Identical
 * concurrent lookups are coalesced (deduplicated) so a lookup storm resolves once.
 *
 * @important This sprint performs NO transport negotiation — no NAT traversal, ICE, STUN,
 * TURN, WebRTC, QUIC, TCP, or P2P sockets. It answers WHO a peer is + WHICH devices they
 * have. Future Layer 6 sprints (Presence, Capability Exchange, NAT Traversal) consume this
 * manager and these events.
 *
 * @security Sessions, metadata, DTOs, and events carry PUBLIC data only — public
 * identity/device keys + fingerprints, ids, states, counts — never private keys, session
 * keys, message keys, chain keys, or shared secrets.
 *
 * @example
 * ```js
 * import { DiscoveryManager, createInMemoryDiscoveryRepository, createInMemoryDirectory } from "./peer-discovery/index.js";
 * const repo = createInMemoryDiscoveryRepository();
 * const directory = createInMemoryDirectory({ u2: { identity, devices } });
 * const discovery = new DiscoveryManager({ ...repo, directory });
 * const { session } = await discovery.lookupUser({ requester: "u1", targetUser: "u2" });
 * session.result.devices; // discoverable device descriptors (public keys only)
 * ```
 */

import crypto from "node:crypto";
import {
  DiscoveryState,
  DiscoveryEventType,
  DiscoveryFailureReason,
  DiscoverySource,
  LookupType,
  DEFAULT_DEDUPE_WINDOW_MS,
} from "../types/types.js";
import { DiscoveryError, UnknownUserError, UnknownDeviceError } from "../errors.js";
import { assertDiscoveryTransition } from "../lifecycle/lifecycle.js";
import {
  createDiscoverySession,
  discoveryDedupeKey,
  isDiscoverySessionExpired,
  inferLookupType,
} from "../session/discoverySession.js";
import { DiscoveryRegistry } from "../registry/registry.js";
import { DiscoveryCache, cacheKey } from "../cache/cache.js";
import { DiscoveryEventBus } from "../events/events.js";
import { createAuditEntry, appendAudit } from "../metadata/metadata.js";
import {
  validateLookupRequest,
  validateUserRef,
  validateDiscoveryId,
  requireDiscoverySession,
  assertRequester,
  assertNoDuplicateDiscovery,
  validateSessionRepository,
} from "../validators/validators.js";
import {
  toPublicDiscoverySession,
  toDiscoveryStatus,
  toPublicDiscoveryMetadata,
  toDiscoveryListItem,
} from "../serializers/serializer.js";

export class DiscoveryManager {
  /**
   * @param {object} deps
   * @param {object} deps.sessions discovery-session repository (required)
   * @param {object} deps.registry registry-entry repository (required) OR a built {@link DiscoveryRegistry}
   * @param {object} [deps.directory] authoritative directory provider (identity/devices)
   * @param {DiscoveryCache} [deps.cache]
   * @param {DiscoveryEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {number} [deps.dedupeWindowMs]
   */
  constructor(deps) {
    if (!deps || !deps.sessions) throw new Error("DiscoveryManager requires { sessions }");
    this.sessions = validateSessionRepository(deps.sessions);
    this.events = deps.events ?? new DiscoveryEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.dedupeWindowMs = deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;

    // The registry may be passed pre-built, or as a repository we wrap here.
    this.registry =
      deps.registry instanceof DiscoveryRegistry
        ? deps.registry
        : new DiscoveryRegistry({
            entries: deps.registry,
            directory: deps.directory,
            events: this.events,
            clock: this.clock,
          });

    this.cache = deps.cache ?? new DiscoveryCache({ clock: this.clock });

    /** @private in-flight coalescing: dedupeKey -> Promise<session DTO> */
    this._inflight = new Map();
  }

  // === registration ========================================================

  /**
   * Register a discoverable device. Invalidates any cached lookups for the user so the
   * next lookup reflects the new device.
   * @param {object} device raw device record (public key only)
   * @returns {Promise<object>} the stored device descriptor
   */
  async registerDevice(device) {
    const descriptor = await this.registry.registerDevice(device);
    this.cache.invalidateUser(descriptor.userId);
    this.events.emit(DiscoveryEventType.CACHE_INVALIDATED, { userId: descriptor.userId, reason: "device-registered" });
    return descriptor;
  }

  /**
   * Deregister a device and invalidate the user's cached lookups.
   * @param {string} userId @param {string} deviceId @returns {Promise<boolean>}
   */
  async deregisterDevice(userId, deviceId) {
    const removed = await this.registry.deregisterDevice(userId, deviceId);
    this.cache.invalidateUser(userId);
    return removed;
  }

  // === lookups =============================================================

  /**
   * Look up a user → their identity + all discoverable devices. Creates a discovery
   * session, resolves (cache → registry → directory), caches the result, and returns the
   * resolved session. Identical concurrent lookups are coalesced.
   * @param {{ requester: string, targetUser: string, requesterDevice?: string, ttlMs?: number, metadata?: object }} request
   * @returns {Promise<{ session: object, metadata: object|null }>}
   */
  async lookupUser(request) {
    return this._runLookup({ ...request, lookupType: LookupType.USER, targetDevices: [] });
  }

  /**
   * Look up a single device of a user.
   * @param {{ requester: string, targetUser: string, deviceId: string, requesterDevice?: string, ttlMs?: number, metadata?: object }} request
   * @returns {Promise<{ session: object, metadata: object|null }>}
   */
  async lookupDevice(request) {
    return this._runLookup({
      ...request,
      lookupType: LookupType.DEVICE,
      targetDevices: [request.deviceId],
    });
  }

  /**
   * Look up a specific subset of a user's devices (or all when `deviceIds` is empty).
   * @param {{ requester: string, targetUser: string, deviceIds?: string[], requesterDevice?: string, ttlMs?: number, metadata?: object }} request
   * @returns {Promise<{ session: object, metadata: object|null }>}
   */
  async lookupDevices(request) {
    const targetDevices = request.deviceIds ?? [];
    return this._runLookup({
      ...request,
      lookupType: inferLookupType(targetDevices),
      targetDevices,
    });
  }

  /**
   * Create a discovery session WITHOUT resolving it yet (CREATED → PENDING). Useful when
   * a caller wants to stage a lookup and drive it explicitly. Emits `STARTED`.
   * @param {object} request @returns {Promise<object>} public session DTO
   */
  async createDiscoverySession(request) {
    const normalized = this._normalize(request);
    await this._guardDuplicate(normalized);
    const session = await this._create(normalized);
    return this._transition(session, DiscoveryState.PENDING, {
      event: DiscoveryEventType.STARTED,
      audit: createAuditEntry("started", { at: this._nowIso() }),
    });
  }

  // === queries =============================================================

  /** Load a discovery session by id (public DTO). @throws {DiscoveryNotFoundError} */
  async getDiscovery(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    // A lazy sweep may transition the session to EXPIRED; use the post-sweep record so the
    // returned DTO reflects the current state (not the pre-sweep snapshot).
    const current = (await this._sweepIfExpired(session)) ?? session;
    return toPublicDiscoverySession(current, { includeAudit: options.includeAudit });
  }

  /** Compact status of a discovery session (for polling). */
  async getDiscoveryStatus(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    const current = (await this._sweepIfExpired(session)) ?? session;
    return toDiscoveryStatus(current);
  }

  /** List a requester's discovery sessions (optionally active-only). */
  async listDiscoveries(requester, options = {}) {
    validateUserRef(requester);
    const list = await this.sessions.listByRequester(String(requester), { activeOnly: options.activeOnly });
    return list.map(toDiscoveryListItem);
  }

  /** List a requester's ACTIVE discovery sessions. */
  async listActiveDiscoveries(requester) {
    return this.listDiscoveries(requester, { activeOnly: true });
  }

  // === lifecycle actions ===================================================

  /**
   * Mark a resolved session COMPLETED (the caller consumed the result). Emits `COMPLETED`.
   * @param {string} discoveryId @param {{ actingUser?: string }} [options]
   */
  async completeDiscovery(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    if (session.state !== DiscoveryState.RESOLVED) {
      throw new DiscoveryError(`Only a resolved discovery can be completed (state: ${session.state})`, {
        code: "ERR_DISCOVERY_INVALID_STATE",
        status: 409,
        details: { state: session.state },
      });
    }
    return this._transition(session, DiscoveryState.COMPLETED, {
      patch: { completedAt: this._nowIso() },
      event: DiscoveryEventType.COMPLETED,
      audit: createAuditEntry("completed", { at: this._nowIso() }),
    });
  }

  /**
   * Cancel an active discovery session. Emits `CANCELLED`.
   * @param {string} discoveryId @param {{ actingUser?: string, reason?: string }} [options]
   */
  async cancelDiscovery(discoveryId, options = {}) {
    const session = await this._require(discoveryId);
    if (options.actingUser) assertRequester(session, options.actingUser);
    if (![DiscoveryState.CREATED, DiscoveryState.PENDING, DiscoveryState.SEARCHING, DiscoveryState.RESOLVED].includes(session.state)) {
      throw new DiscoveryError(`Cannot cancel a discovery in state "${session.state}"`, {
        code: "ERR_DISCOVERY_INVALID_STATE",
        status: 409,
        details: { state: session.state },
      });
    }
    return this._transition(session, DiscoveryState.CANCELLED, {
      patch: { failureReason: DiscoveryFailureReason.CANCELLED },
      reason: options.reason ?? "cancelled",
      event: DiscoveryEventType.CANCELLED,
      audit: createAuditEntry("cancelled", { at: this._nowIso(), reason: options.reason }),
    });
  }

  /**
   * Sweep expired active sessions to EXPIRED (housekeeping / a scheduler hook). Also prunes
   * the discovery cache. @param {number} [now] @returns {Promise<{ expired: number, cachePruned: number }>}
   */
  async sweepExpired(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const stale = await this.sessions.listExpired(nowIso);
    let expired = 0;
    for (const session of stale) {
      try {
        await this._transition(session, DiscoveryState.EXPIRED, {
          patch: { failureReason: DiscoveryFailureReason.EXPIRED_SESSION },
          reason: "ttl-elapsed",
          event: DiscoveryEventType.EXPIRED,
          audit: createAuditEntry("expired", { at: nowIso }),
        });
        expired++;
      } catch {
        // A concurrent transition may have already moved it; ignore.
      }
    }
    const cachePruned = this.cache.pruneExpired(now);
    return { expired, cachePruned };
  }

  /** Delete a discovery session record (housekeeping). */
  async deleteDiscovery(discoveryId) {
    validateDiscoveryId(discoveryId);
    return { discoveryId: String(discoveryId), deleted: await this.sessions.delete(discoveryId) };
  }

  /** Cache statistics snapshot (observability). */
  cacheStats() {
    return this.cache.stats();
  }

  // === internals ==========================================================

  /**
   * @private Normalize + validate a raw lookup request into a canonical shape.
   */
  _normalize(request) {
    validateLookupRequest(request);
    const targetDevices = (request.targetDevices ?? []).map(String);
    return {
      requester: String(request.requester),
      requesterDevice: request.requesterDevice ? String(request.requesterDevice) : undefined,
      targetUser: String(request.targetUser),
      targetDevices,
      lookupType: request.lookupType ?? inferLookupType(targetDevices),
      ttlMs: request.ttlMs,
      metadata: request.metadata,
    };
  }

  /** @private Reject a lookup that duplicates an in-flight one. */
  async _guardDuplicate(normalized) {
    const key = discoveryDedupeKey(normalized);
    const existing = await this.sessions.findActiveByDedupeKey(key);
    assertNoDuplicateDiscovery(existing);
  }

  /** @private Persist a fresh CREATED session. */
  async _create(normalized) {
    const session = createDiscoverySession({
      ...normalized,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    session.audit = appendAudit(session.audit, createAuditEntry("created", { at: this._nowIso() }));
    return this.sessions.create(session);
  }

  /**
   * @private The full create → resolve pipeline with in-flight coalescing. Identical
   * concurrent lookups share the same promise so the registry/directory is hit once.
   */
  async _runLookup(request) {
    const normalized = this._normalize(request);
    const key = discoveryDedupeKey(normalized);

    if (this._inflight.has(key)) return this._inflight.get(key);

    const promise = this._resolvePipeline(normalized, key).finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }

  /** @private CREATED → PENDING → SEARCHING → RESOLVED (or FAILED). */
  async _resolvePipeline(normalized, dedupeKey) {
    // Reuse an already-active identical session if one exists (cross-process dedupe).
    const active = await this.sessions.findActiveByDedupeKey(dedupeKey);
    let session = active ?? (await this._create(normalized));

    // started → pending (skip if we adopted an already-advanced session)
    if (session.state === DiscoveryState.CREATED) {
      session = await this._transitionRaw(session, DiscoveryState.PENDING, {
        event: DiscoveryEventType.STARTED,
        audit: createAuditEntry("started", { at: this._nowIso() }),
      });
    }
    // pending → searching
    if (session.state === DiscoveryState.PENDING) {
      session = await this._transitionRaw(session, DiscoveryState.SEARCHING, {
        event: DiscoveryEventType.SEARCHING,
      });
    }
    // If another caller already resolved it, return as-is.
    if (session.state === DiscoveryState.RESOLVED) {
      return { session: toPublicDiscoverySession(session), metadata: toPublicDiscoveryMetadata(session.result) };
    }

    try {
      const { metadata } = await this._resolveMetadata(normalized);
      const resolved = await this._transitionRaw(session, DiscoveryState.RESOLVED, {
        patch: { result: metadata, resolvedAt: this._nowIso() },
        event: DiscoveryEventType.RESOLVED,
        eventExtras: { source: metadata.source, deviceCount: metadata.devices.length },
        audit: createAuditEntry("resolved", { at: this._nowIso(), source: metadata.source, deviceCount: metadata.devices.length }),
      });
      return { session: toPublicDiscoverySession(resolved), metadata: toPublicDiscoveryMetadata(metadata) };
    } catch (error) {
      const reason = failureReasonFor(error);
      // Negative-cache genuine "not found" so repeat lookups are cheap + self-healing.
      if (reason === DiscoveryFailureReason.UNKNOWN_USER || reason === DiscoveryFailureReason.UNKNOWN_DEVICE) {
        this.cache.setNegative(normalized.targetUser, normalized.targetDevices);
      }
      const failed = await this._transitionRaw(session, DiscoveryState.FAILED, {
        patch: { failureReason: reason },
        reason,
        event: DiscoveryEventType.FAILED,
        audit: createAuditEntry("failed", { at: this._nowIso(), reason }),
      });
      // A failed lookup returns a session (with failureReason) rather than throwing, so the
      // caller can inspect the outcome; hard validation/authorization errors still throw.
      if (error instanceof DiscoveryError && error.status < 500 && !isNotFound(error)) throw error;
      return { session: toPublicDiscoverySession(failed), metadata: null };
    }
  }

  /**
   * @private Resolve metadata with the cache in front of the registry/directory.
   * @returns {Promise<{ metadata: object }>}
   */
  async _resolveMetadata(normalized) {
    const { targetUser, targetDevices } = normalized;
    const probe = this.cache.get(targetUser, targetDevices);
    if (probe.outcome === "hit") {
      return { metadata: { ...probe.value, source: DiscoverySource.CACHE } };
    }
    if (probe.outcome === "negative") {
      throw new UnknownUserError(`No discoverable identity or devices for user "${targetUser}" (cached)`, {
        details: { userId: targetUser },
      });
    }

    const metadata = await this.registry.resolveMetadata(targetUser, { deviceIds: targetDevices });
    this.cache.set(targetUser, metadata, targetDevices);
    this.events.emit(DiscoveryEventType.CACHED, {
      userId: targetUser,
      deviceCount: metadata.devices.length,
      details: { key: cacheKey(targetUser, targetDevices) },
    });
    return { metadata };
  }

  /** @private Load + require a session by id (validated). */
  async _require(discoveryId) {
    validateDiscoveryId(discoveryId);
    return requireDiscoverySession(await this.sessions.findById(discoveryId), discoveryId);
  }

  /**
   * @private Move an active-but-expired session to EXPIRED lazily on read.
   * @returns {Promise<object|null>} the updated (EXPIRED) record, or null if no sweep occurred.
   */
  async _sweepIfExpired(session) {
    if (
      isDiscoverySessionExpired(session, this.clock()) &&
      [DiscoveryState.CREATED, DiscoveryState.PENDING, DiscoveryState.SEARCHING].includes(session.state)
    ) {
      return this._transitionRaw(session, DiscoveryState.EXPIRED, {
        patch: { failureReason: DiscoveryFailureReason.EXPIRED_SESSION },
        reason: "ttl-elapsed",
        event: DiscoveryEventType.EXPIRED,
        audit: createAuditEntry("expired", { at: this._nowIso() }),
      });
    }
    return null;
  }

  /** @private Guarded transition → returns the public DTO. */
  async _transition(session, toState, options = {}) {
    const updated = await this._transitionRaw(session, toState, options);
    return toPublicDiscoverySession(updated, { includeAudit: options.includeAudit });
  }

  /** @private Guarded transition → returns the raw record (for pipelining). */
  async _transitionRaw(session, toState, options = {}) {
    assertDiscoveryTransition(session.state, toState);
    const at = this._nowIso();
    const patch = {
      state: toState,
      history: [...(session.history ?? []), { from: session.state, to: toState, at, reason: options.reason }],
      updatedAt: at,
      ...(options.patch ?? {}),
    };
    if (options.audit) patch.audit = appendAudit(session.audit, options.audit);
    const updated = await this.sessions.update(session.discoveryId, patch);
    if (options.event) {
      this.events.emit(options.event, {
        discoveryId: updated.discoveryId,
        requester: updated.requester,
        targetUser: updated.targetUser,
        lookupType: updated.lookupType,
        previousState: session.state,
        state: toState,
        reason: options.reason,
        ...(options.eventExtras ?? {}),
      });
    }
    return updated;
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Map a resolution error to a machine-readable failure reason. */
function failureReasonFor(error) {
  if (error instanceof UnknownUserError) return DiscoveryFailureReason.UNKNOWN_USER;
  if (error instanceof UnknownDeviceError) return DiscoveryFailureReason.UNKNOWN_DEVICE;
  if (error?.code === "ERR_DISCOVERY_DIRECTORY_UNAVAILABLE") return DiscoveryFailureReason.DIRECTORY_UNAVAILABLE;
  if (error?.code === "ERR_DISCOVERY_CORRUPTED_METADATA") return DiscoveryFailureReason.CORRUPTED_METADATA;
  if (error?.code === "ERR_DISCOVERY_VALIDATION") return DiscoveryFailureReason.MALFORMED_REQUEST;
  return DiscoveryFailureReason.INTERNAL_ERROR;
}

/** Whether an error is a "not found" (which we surface as a failed session, not a throw). */
function isNotFound(error) {
  return error instanceof UnknownUserError || error instanceof UnknownDeviceError;
}

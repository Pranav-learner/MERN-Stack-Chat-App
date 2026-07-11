/**
 * @module network-discovery/manager
 *
 * The **Network Discovery Manager** — the reusable facade for Layer 7, Sprint 1. It discovers a
 * device's network environment and produces a {@link module:network-discovery/profile NetworkProfile}
 * + ICE-style candidates. Its responsibilities (the sprint spec): inspect the local network, detect
 * interfaces, discover public/private addresses, detect NAT, generate the profile, gather
 * candidates, cache results, validate, and manage the lifecycle.
 *
 * It is INJECTABLE + transport-independent: it takes an `interfaceProvider` (Node `os`, browser, or
 * static) and a `stunClient` (real UDP or mock). A caller may also REPORT already-gathered data
 * (interfaces / STUN results / candidates the device produced) and the manager validates + assembles
 * the profile — the standard flow when the browser gathers candidates itself.
 *
 * @important This sprint discovers + gathers ONLY. It performs NO ICE connectivity checks, NO
 * candidate-pair selection, NO TURN relay, and opens NO peer socket. A future ICE sprint consumes
 * the profile + candidates.
 *
 * @security Profiles/candidates carry PUBLIC addressing metadata only — never a private key, session
 * key, message key, chain key, or shared secret.
 *
 * @example
 * ```js
 * const mgr = new NetworkDiscoveryManager({ ...createInMemoryDiscoveryRepository(), interfaceProvider, stunClient });
 * const profile = await mgr.generateProfile({ deviceId: "d1", userId: "u1" });
 * profile.natType; profile.candidates; // ready for ICE (Sprint 2)
 * ```
 */

import crypto from "node:crypto";
import {
  ProfileState,
  DiscoveryEventType,
  DiscoverySource,
  DEFAULT_PROFILE_TTL_MS,
} from "../types/types.js";
import { DiscoveryError } from "../errors.js";
import { isInterfaceProvider, usableInterfaces } from "../interfaces/interfaces.js";
import { gatherCandidates, normalizeCandidate, isCandidateExpired } from "../candidates/candidate.js";
import { classifyNat } from "../nat/natDetector.js";
import { createNetworkProfile, isProfileExpired, networkSignature } from "../profile/profile.js";
import { NetworkProfileCache } from "../cache/cache.js";
import { DiscoveryEventBus } from "../events/events.js";
import {
  validateGenerateRequest,
  validateProfileId,
  validateDeviceRef,
  validateCandidates,
  requireProfile,
  assertOwner,
  assertNoSecretMaterial,
  validateProfileRepository,
} from "../validators/validators.js";
import {
  toPublicProfile,
  toPublicCandidate,
  toProfileSummary,
  toNatInfo,
  toPublicAddress,
  toDiagnostics,
} from "../serializers/serializer.js";

export class NetworkDiscoveryManager {
  /**
   * @param {object} deps
   * @param {object} deps.profiles profile repository (required)
   * @param {object} [deps.history] history repository (optional; enables history)
   * @param {object} [deps.interfaceProvider] `{ list() }` (Node/browser/static)
   * @param {object} [deps.stunClient] a {@link module:network-discovery/stun/stunClient StunClient} (optional)
   * @param {Array<object>} [deps.stunServers] @param {NetworkProfileCache} [deps.cache]
   * @param {DiscoveryEventBus} [deps.events] @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {number} [deps.profileTtlMs]
   */
  constructor(deps) {
    if (!deps || !deps.profiles) throw new Error("NetworkDiscoveryManager requires { profiles }");
    this.profiles = validateProfileRepository(deps.profiles);
    this.history = deps.history ?? null;
    this.interfaceProvider = deps.interfaceProvider ?? null;
    if (this.interfaceProvider && !isInterfaceProvider(this.interfaceProvider)) {
      throw new Error("interfaceProvider must implement list()");
    }
    this.stunClient = deps.stunClient ?? null;
    this.stunServers = deps.stunServers;
    this.events = deps.events ?? new DiscoveryEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.profileTtlMs = deps.profileTtlMs ?? DEFAULT_PROFILE_TTL_MS;
    this.cache = deps.cache ?? new NetworkProfileCache({ clock: this.clock });
  }

  // === discovery ===========================================================

  /**
   * Generate a device's network profile: gather interfaces + STUN results (or use reported data),
   * gather candidates, classify NAT, assemble + store the profile. Emits the discovery lifecycle
   * events. @returns {Promise<object>} public profile DTO.
   *
   * @param {{ deviceId: string, userId?: string, interfaces?: object[], stunResults?: object[],
   *   candidates?: object[], stunServers?: object[], ttlMs?: number, previousProfileId?: string, action?: string }} request
   */
  async generateProfile(request) {
    validateGenerateRequest(request);
    this.events.emit(DiscoveryEventType.DISCOVERY_STARTED, { deviceId: request.deviceId, userId: request.userId });
    const at = this._nowIso();

    // 1. Interfaces — reported or provider-supplied.
    const interfaces = request.interfaces ?? (this.interfaceProvider ? await this.interfaceProvider.list() : []);
    if (interfaces.length === 0 && !request.candidates) {
      const failed = await this._failProfile(request, "no-interfaces");
      return failed;
    }

    // 2. STUN — reported, or resolved via the client (best-effort; never throws the whole discovery).
    let stunResults = request.stunResults ?? [];
    if (!request.stunResults && !request.candidates && this.stunClient) {
      stunResults = await this._runStun(request.stunServers);
    }
    for (const r of stunResults) {
      if (r.ok && r.reflexive) this.events.emit(DiscoveryEventType.STUN_RESOLVED, { deviceId: request.deviceId, server: serverKey(r.server), publicAddress: r.reflexive.ip, latencyMs: r.latencyMs });
      else if (r.ok === false) this.events.emit(DiscoveryEventType.STUN_FAILED, { deviceId: request.deviceId, server: serverKey(r.server), reason: r.error });
    }

    // 3. Candidates — reported (normalized) or gathered.
    let candidates;
    if (request.candidates) {
      candidates = validateCandidates(request.candidates).map((c) => normalizeCandidate(c, { clock: this.clock, idGenerator: this.idGenerator, ttlMs: request.ttlMs }));
    } else {
      candidates = gatherCandidates({ interfaces: usableInterfaces(interfaces), stunResults, ttlMs: request.ttlMs, clock: this.clock, idGenerator: this.idGenerator }).candidates;
    }
    this.events.emit(DiscoveryEventType.CANDIDATE_GATHERED, { deviceId: request.deviceId, count: candidates.length });

    // 4. NAT classification.
    const hostAddresses = usableInterfaces(interfaces).map((i) => i.address);
    const nat = classifyNat({ hostAddresses, stunResults });
    this.events.emit(DiscoveryEventType.NAT_DETECTED, { deviceId: request.deviceId, natType: nat.natType, publicAddress: nat.publicAddress });

    // 5. Assemble + persist.
    const profile = createNetworkProfile({
      deviceId: request.deviceId,
      userId: request.userId,
      interfaces,
      candidates,
      nat,
      diagnostics: { source: request.candidates ? DiscoverySource.REPORTED : DiscoverySource.COMPUTED, interfaceCount: interfaces.length },
      state: ProfileState.READY,
      ttlMs: request.ttlMs ?? this.profileTtlMs,
      version: request.version ?? 1,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    assertNoSecretMaterial(profile, "network profile");
    const stored = await this.profiles.create(profile);
    this.cache.set(this._deviceKey(stored.deviceId), toPublicProfile(stored));
    await this._recordHistory(stored, request.action ?? "generate", false);
    this.events.emit(DiscoveryEventType.PROFILE_CREATED, { profileId: stored.profileId, deviceId: stored.deviceId, natType: stored.natType });
    return toPublicProfile(stored);
  }

  /**
   * Refresh a device's profile (re-run discovery). Detects a NETWORK CHANGE (different addresses/NAT)
   * vs an unchanged refresh + emits accordingly. @returns {Promise<object>} public profile DTO.
   * @param {string} deviceId @param {{ userId?: string, interfaces?: object[], stunResults?: object[], candidates?: object[], actingUser?: string }} [options]
   */
  async refreshProfile(deviceId, options = {}) {
    validateDeviceRef(deviceId);
    const prior = await this.profiles.findByDevice(deviceId);
    if (prior && options.actingUser) assertOwner(prior, options.actingUser, deviceId);
    const priorVersion = prior?.version ?? 0;
    const priorSig = prior ? networkSignature(prior) : null;

    const profile = await this.generateProfile({
      deviceId,
      userId: options.userId ?? prior?.userId ?? undefined,
      interfaces: options.interfaces,
      stunResults: options.stunResults,
      candidates: options.candidates,
      ttlMs: options.ttlMs,
      version: priorVersion + 1,
      action: "refresh",
    });

    // `generateProfile` already re-cached the fresh profile under the device key, so no separate
    // invalidation is needed here (invalidating would drop the just-written entry).
    const changed = priorSig !== null && priorSig !== networkSignature(profile);
    if (changed) this.events.emit(DiscoveryEventType.NETWORK_CHANGED, { deviceId, natType: profile.natType, publicAddress: profile.publicAddress });
    this.events.emit(DiscoveryEventType.PROFILE_REFRESHED, { profileId: profile.profileId, deviceId, changed });
    return profile;
  }

  // === queries =============================================================

  /** A profile by id (public DTO). Lazily expires on read. */
  async getProfile(profileId, options = {}) {
    validateProfileId(profileId);
    const profile = requireProfile(await this.profiles.findById(profileId), profileId);
    if (options.actingUser || options.actingDevice) assertOwner(profile, options.actingUser, options.actingDevice);
    const current = (await this._sweepIfExpired(profile)) ?? profile;
    return toPublicProfile(current, { includeCandidates: options.includeCandidates });
  }

  /** The current profile for a device (public DTO). Lazily expires on read. */
  async getCurrentProfile(deviceId) {
    validateDeviceRef(deviceId);
    const profile = requireProfile(await this.profiles.findByDevice(deviceId), deviceId);
    const current = (await this._sweepIfExpired(profile)) ?? profile;
    return toPublicProfile(current);
  }

  /** A device's non-expired candidates. */
  async getCandidates(deviceId) {
    validateDeviceRef(deviceId);
    const profile = requireProfile(await this.profiles.findByDevice(deviceId), deviceId);
    const now = this.clock();
    return (profile.candidates ?? []).filter((c) => !isCandidateExpired(c, now)).map(toPublicCandidate);
  }

  /** The device's live interfaces (from the provider or the current profile). */
  async listInterfaces(deviceId) {
    if (deviceId) {
      const profile = await this.profiles.findByDevice(deviceId);
      if (profile) return (profile.interfaces ?? []).map((i) => ({ ...i }));
    }
    return this.interfaceProvider ? this.interfaceProvider.list() : [];
  }

  /** A device's public-address view. */
  async getPublicAddress(deviceId) {
    validateDeviceRef(deviceId);
    return toPublicAddress(requireProfile(await this.profiles.findByDevice(deviceId), deviceId));
  }

  /** A device's NAT-info view. */
  async getNatInfo(deviceId) {
    validateDeviceRef(deviceId);
    return toNatInfo(requireProfile(await this.profiles.findByDevice(deviceId), deviceId));
  }

  /** A device's discovery diagnostics (+ recent history when a history store is present). */
  async getDiagnostics(deviceId, options = {}) {
    validateDeviceRef(deviceId);
    const profile = requireProfile(await this.profiles.findByDevice(deviceId), deviceId);
    const view = toDiagnostics(profile);
    if (this.history) view.history = await this.history.listByDevice(deviceId, { limit: options.limit ?? 20 });
    return view;
  }

  /** Summaries of a user's profiles. */
  async listUserProfiles(userId) {
    return (await this.profiles.listByUser(userId)).map(toProfileSummary);
  }

  // === lifecycle ===========================================================

  /** Sweep expired live profiles → EXPIRED. Emits `CANDIDATE_EXPIRED`. @returns {Promise<{ expired: number, cachePruned: number }>} */
  async sweepExpired(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const stale = await this.profiles.listExpired(nowIso);
    let expired = 0;
    for (const profile of stale) {
      try {
        await this.profiles.update(profile.profileId, { state: ProfileState.EXPIRED, updatedAt: nowIso });
        this.cache.invalidateDevice(profile.deviceId);
        await this._recordHistory(profile, "expire", false);
        this.events.emit(DiscoveryEventType.CANDIDATE_EXPIRED, { profileId: profile.profileId, deviceId: profile.deviceId, count: (profile.candidates ?? []).length });
        expired++;
      } catch {
        // concurrent update already moved it
      }
    }
    const cachePruned = this.cache.pruneExpired(now);
    return { expired, cachePruned };
  }

  /** Cache statistics snapshot. */
  cacheStats() {
    return this.cache.stats();
  }

  // === internals ==========================================================

  /** @private Run STUN across all servers (best-effort). */
  async _runStun(stunServers) {
    try {
      return await this.stunClient.resolveAll({ servers: stunServers ?? this.stunServers });
    } catch {
      return [];
    }
  }

  /** @private Persist a FAILED profile (no interfaces / discovery error) + return its DTO. */
  async _failProfile(request, reason) {
    const nat = classifyNat({ hostAddresses: [], stunResults: [] });
    const profile = createNetworkProfile({
      deviceId: request.deviceId,
      userId: request.userId,
      interfaces: request.interfaces ?? [],
      candidates: [],
      nat,
      state: ProfileState.FAILED,
      diagnostics: { reason },
      ttlMs: request.ttlMs ?? this.profileTtlMs,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    const stored = await this.profiles.create(profile);
    this.events.emit(DiscoveryEventType.DISCOVERY_FAILED, { deviceId: request.deviceId, reason });
    return toPublicProfile(stored);
  }

  /** @private Lazily move a live-but-expired profile to EXPIRED on read. */
  async _sweepIfExpired(profile) {
    if ([ProfileState.DISCOVERING, ProfileState.READY].includes(profile.state) && isProfileExpired(profile, this.clock())) {
      const updated = await this.profiles.update(profile.profileId, { state: ProfileState.EXPIRED, updatedAt: this._nowIso() });
      this.cache.invalidateDevice(profile.deviceId);
      this.events.emit(DiscoveryEventType.CANDIDATE_EXPIRED, { profileId: profile.profileId, deviceId: profile.deviceId });
      return updated;
    }
    return null;
  }

  /** @private Append a history snapshot (when a history store is present). */
  async _recordHistory(profile, action, changed) {
    if (!this.history) return;
    try {
      await this.history.record({
        profileId: profile.profileId,
        deviceId: profile.deviceId,
        action,
        natType: profile.natType,
        publicAddress: profile.publicAddress ?? null,
        candidateCount: (profile.candidates ?? []).length,
        signature: networkSignature(profile),
        changed,
        diagnostics: profile.diagnostics ?? {},
        at: this._nowIso(),
        schemaVersion: profile.schemaVersion,
      });
    } catch {
      // history is best-effort
    }
  }

  /** @private */
  _deviceKey(deviceId) {
    return `device:${deviceId}`;
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Compact "host:port" for a STUN server (for events). */
function serverKey(server) {
  return server ? `${server.host}:${server.port}` : "unknown";
}

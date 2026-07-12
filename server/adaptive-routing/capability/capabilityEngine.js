/**
 * @module adaptive-routing/capability/capabilityEngine
 *
 * The **Capability Engine** (STEP 3) — collects sender + receiver + device capabilities and returns an
 * IMMUTABLE, negotiated {@link CapabilityProfile}. It NEVER queries a service directly: a deployment
 * injects a `capabilityProvider(identityId, deviceId)` resolver (backed by Layer 3 device-trust / Layer 6
 * capability exchange, or a registry), and the engine folds a per-request declaration over it, then over
 * the permissive baseline. Absent a provider + declaration, the baseline keeps the Fabric fully
 * functional. The Decision Engine consumes the returned PROFILE — decoupling routing from live services.
 *
 * @performance Profiles are memoized by (identityId, deviceId) in a TTL/LRU cache — capability rarely
 * changes, so repeated evaluations for the same party skip re-collection. Collection is pure + synchronous.
 *
 * @security Reasons over declared capability metadata only (versions + transport/feature/media ids).
 */

import { createCapabilityProfile, negotiateProfiles } from "./capabilityProfile.js";
import { InvalidCapabilityError } from "../errors.js";
import { MIN_PROTOCOL_VERSION, DEFAULT_CAPABILITY_CACHE_TTL_MS, DEFAULT_CAPABILITY_CACHE_MAX, AdaptiveEventType } from "../types/types.js";

export class CapabilityEngine {
  /**
   * @param {object} [deps]
   * @param {(identityId: string, deviceId?: string) => object|null} [deps.capabilityProvider] service-agnostic resolver
   * @param {import("../events/events.js").AdaptiveEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   * @param {object} [deps.cacheOptions] `{ ttlMs, max }`
   */
  constructor(deps = {}) {
    this.capabilityProvider = deps.capabilityProvider ?? null;
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this._cache = new Map(); // key → { value, expiresAt }
    this.ttlMs = deps.cacheOptions?.ttlMs ?? DEFAULT_CAPABILITY_CACHE_TTL_MS;
    this.max = deps.cacheOptions?.max ?? DEFAULT_CAPABILITY_CACHE_MAX;
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Collect the negotiated capability profile for a communication.
   * @param {object} params
   * @param {string} params.senderId @param {string[]} [params.receiverIds]
   * @param {object} [params.senderDeclaration] a per-request sender declaration (overrides provider gaps)
   * @param {object[]} [params.receiverDeclarations] per-request receiver declarations
   * @returns {{ sender: object, receivers: object[], negotiated: object }}
   */
  collect(params = {}) {
    const at = new Date(this.clock()).toISOString();
    const sender = this._profileFor(params.senderId, null, params.senderDeclaration, at);

    const receiverIds = params.receiverIds ?? [];
    const decls = params.receiverDeclarations ?? [];
    const receivers = receiverIds.map((id, i) => this._profileFor(id, null, decls[i], at));
    // include any declared receivers that weren't in the id list (e.g. group members declared explicitly)
    for (let i = receiverIds.length; i < decls.length; i++) receivers.push(this._profileFor(decls[i]?.identityId, null, decls[i], at));

    const negotiated = negotiateProfiles(sender, receivers, { at });
    this._validate(negotiated);

    this.events?.emit(AdaptiveEventType.CAPABILITIES_COLLECTED, { senderId: params.senderId, receiverCount: receivers.length, negotiatedFingerprint: negotiated.fingerprint, transports: negotiated.transports });
    return { sender, receivers, negotiated };
  }

  /** Resolve one party's profile: provider → per-request declaration → baseline, memoized. */
  _profileFor(identityId, deviceId, declaration, at) {
    const key = `${identityId ?? "?"}::${deviceId ?? "?"}::${declaration ? "d" : ""}`;
    const cached = this._cacheGet(key);
    if (cached) return cached;

    let raw = {};
    if (this.capabilityProvider && identityId) {
      try {
        raw = this.capabilityProvider(identityId, deviceId) ?? {};
      } catch {
        raw = {}; // a failing provider never breaks collection — fall back to baseline
      }
    }
    const merged = { ...raw, ...(declaration ?? {}), identityId: identityId ?? declaration?.identityId ?? null, deviceId: deviceId ?? declaration?.deviceId ?? null };
    const profile = createCapabilityProfile(merged, { at });
    this._cacheSet(key, profile);
    return profile;
  }

  _validate(profile) {
    if (!profile || !Array.isArray(profile.transports)) throw new InvalidCapabilityError("Negotiated profile has no transports");
    if (profile.protocolVersion < MIN_PROTOCOL_VERSION) throw new InvalidCapabilityError(`Protocol version ${profile.protocolVersion} below minimum ${MIN_PROTOCOL_VERSION}`, { details: { protocolVersion: profile.protocolVersion } });
    if (profile.transports.length === 0) throw new InvalidCapabilityError("Capability negotiation produced no common transport", { details: { fingerprint: profile.fingerprint } });
  }

  _cacheGet(key) {
    const e = this._cache.get(key);
    if (!e) {
      this.misses++;
      return null;
    }
    if (e.expiresAt <= this.clock()) {
      this._cache.delete(key);
      this.misses++;
      return null;
    }
    this._cache.delete(key);
    this._cache.set(key, e);
    this.hits++;
    return e.value;
  }

  _cacheSet(key, value) {
    if (this._cache.has(key)) this._cache.delete(key);
    this._cache.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    while (this._cache.size > this.max) this._cache.delete(this._cache.keys().next().value);
  }

  stats() {
    const total = this.hits + this.misses;
    return { size: this._cache.size, hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0 };
  }
}

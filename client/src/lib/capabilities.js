/**
 * Client Capability Exchange integration (Layer 6, Sprint 3).
 *
 * Makes the client a participant in the capability-negotiation control plane: it automatically
 * registers this device's capabilities, updates them + feature flags, negotiates with a peer's
 * device to learn *how they can communicate*, and resolves the PREFERRED transport. It determines
 * a communication STRATEGY — it establishes NO connection (no NAT traversal, ICE, WebRTC, or P2P —
 * those are future sprints).
 *
 * @security Handles PUBLIC capability metadata ONLY — protocol/crypto versions, transport names,
 * feature flags, limits. It never handles a private key, session key, message key, or shared
 * secret.
 *
 * @example
 * ```js
 * import { CapabilityClient } from "../lib/capabilities.js";
 * const caps = new CapabilityClient({ axios, deviceId });
 * await caps.register();
 * const plan = await caps.negotiate(peerId, peerDeviceId);
 * if (plan?.compatible) usePreferredTransport(plan.preferredTransport); // future layer establishes it
 * ```
 */

/** Transport types (mirrors the server). */
export const TransportType = Object.freeze({
  WEBSOCKET: "websocket",
  RELAY: "relay",
  WEBRTC: "webrtc",
  QUIC: "quic",
  TCP: "tcp",
});

/** Transport-preference policy names (mirrors the server). */
export const TransportPolicy = Object.freeze({
  AUTO: "auto",
  PREFER_WEBRTC: "prefer-webrtc",
  PREFER_QUIC: "prefer-quic",
  PREFER_RELAY: "prefer-relay",
  PREFER_WEBSOCKET: "prefer-websocket",
});

/** The capabilities this build advertises by default (transports available today + placeholders). */
export const DEFAULT_CAPABILITIES = Object.freeze({
  protocolVersions: ["1.0"],
  cryptoVersions: ["1.0"],
  transports: [TransportType.WEBSOCKET, TransportType.RELAY],
  compression: ["gzip", "none"],
  featureFlags: { typing: true, receipts: true, reactions: true },
});

/**
 * A stateful client that owns this device's capability set + a cache of negotiation plans.
 */
export class CapabilityClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios
   * @param {string} deps.deviceId this device's stable id
   * @param {object} [deps.capabilities] capability overrides (merged over DEFAULT_CAPABILITIES)
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("CapabilityClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(deps.capabilities ?? {}) };
    /** @type {object|null} this device's registered capability set */
    this.self = null;
    /** @type {Map<string, object>} `${peerId}:${peerDeviceId}` → last negotiation plan */
    this._plans = new Map();
  }

  // === registration + updates ==============================================

  /**
   * Register this device's capabilities. Idempotent — a duplicate (409) means already registered.
   * @returns {Promise<object|null>} the registered capability set
   */
  async register() {
    try {
      const { data } = await this.axios.post("/api/capabilities/register", { deviceId: this.deviceId, ...this.capabilities });
      if (data?.success) this.self = data.capabilities;
    } catch (error) {
      if (error?.response?.status !== 409) {
        console.warn("[capabilities] register failed:", error?.response?.data?.message ?? error?.message ?? error);
      }
    }
    return this.self;
  }

  /**
   * Update this device's capabilities (bumps the version, invalidating peers' cached plans).
   * @param {object} patch capability fields to change @returns {Promise<object|null>}
   */
  async update(patch) {
    if (!this.self?.capabilityId) return null;
    try {
      const { data } = await this.axios.patch(`/api/capabilities/${this.self.capabilityId}`, patch);
      if (data?.success) {
        this.self = data.capabilities;
        this._plans.clear(); // our caps changed → drop stale plans
      }
      return this.self;
    } catch (error) {
      console.warn("[capabilities] update failed:", error?.response?.data?.message ?? error?.message ?? error);
      return null;
    }
  }

  /**
   * Enable/disable feature flags (a convenience over {@link update}).
   * @param {Record<string, boolean>} flags @returns {Promise<object|null>}
   */
  async setFeatureFlags(flags) {
    const featureFlags = { ...(this.self?.featureFlags ?? this.capabilities.featureFlags), ...flags };
    return this.update({ featureFlags });
  }

  /** Refresh this device's capability TTL (keep it live). */
  async refresh() {
    if (!this.self?.capabilityId) return null;
    try {
      const { data } = await this.axios.post(`/api/capabilities/${this.self.capabilityId}/refresh`, {});
      if (data?.success) this.self = data.capabilities;
      return this.self;
    } catch (error) {
      console.warn("[capabilities] refresh failed:", error?.response?.data?.message ?? error?.message ?? error);
      return null;
    }
  }

  // === negotiation =========================================================

  /**
   * Negotiate how this device + a peer's device can communicate.
   * @param {string} peerId @param {string} peerDeviceId
   * @param {{ policy?: string }} [options]
   * @returns {Promise<object|null>} the negotiation result (compatibility + preferred transport)
   */
  async negotiate(peerId, peerDeviceId, options = {}) {
    try {
      const { data } = await this.axios.post("/api/capabilities/negotiate", {
        requesterDevice: this.deviceId,
        targetUser: peerId,
        targetDevice: peerDeviceId,
        policy: options.policy,
      });
      if (data?.success) {
        this._plans.set(`${peerId}:${peerDeviceId}`, data.result);
        return data.result;
      }
    } catch (error) {
      console.warn("[capabilities] negotiate failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  /**
   * Resolve just the preferred transport (+ fallback chain) for a peer's device.
   * @param {string} peerId @param {string} peerDeviceId @param {{ policy?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async resolvePreferredTransport(peerId, peerDeviceId, options = {}) {
    try {
      const { data } = await this.axios.post("/api/capabilities/preferred-transport", {
        requesterDevice: this.deviceId,
        targetUser: peerId,
        targetDevice: peerDeviceId,
        policy: options.policy,
      });
      return data?.success ? data.transport : null;
    } catch (error) {
      console.warn("[capabilities] preferred-transport failed:", error?.response?.data?.message ?? error?.message ?? error);
      return null;
    }
  }

  /** A peer device's advertised capabilities. */
  async getPeerCapabilities(peerId, peerDeviceId) {
    try {
      const { data } = await this.axios.get(`/api/capabilities/device/${peerId}/${peerDeviceId}`);
      return data?.success ? data.capabilities : null;
    } catch {
      return null;
    }
  }

  /** The cached negotiation plan for a peer device (no network). */
  getCachedPlan(peerId, peerDeviceId) {
    return this._plans.get(`${peerId}:${peerDeviceId}`) ?? null;
  }

  // === FUTURE hooks (inert — later Layer 6/7 sprints fill these) ============

  /**
   * FUTURE (Layer 6/7 · NAT Traversal sprint): given a negotiation plan, this is where the client
   * would hand the preferred transport + (future) ICE candidates to a connection establisher. Inert
   * in Sprint 3 — it only returns the preferred transport to use; it opens nothing.
   * @param {string} peerId @param {string} peerDeviceId @returns {{ preferredTransport: string|null, fallbackChain: string[] }|null}
   */
  getTransportPlan(peerId, peerDeviceId) {
    const plan = this.getCachedPlan(peerId, peerDeviceId);
    if (!plan) return null;
    return { preferredTransport: plan.preferredTransport ?? null, fallbackChain: plan.fallbackChain ?? [] };
  }

  /** Clear cached negotiation plans (e.g. on logout). */
  clear() {
    this._plans.clear();
  }
}

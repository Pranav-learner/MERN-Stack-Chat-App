/**
 * Client Network Discovery integration (Layer 7, Sprint 1).
 *
 * Drives per-device network discovery from the browser: it gathers the device's network signals
 * (interfaces / ICE-style candidates) via an INJECTED gatherer, submits them to the server to build
 * a Network Profile, caches the profile, auto-refreshes on network changes, and exposes future
 * connection-establishment hooks. It produces a PROFILE + candidates only — it establishes NO
 * connection (no ICE checks, TURN, or peer sockets; that is a future sprint).
 *
 * @security Handles PUBLIC network addressing metadata ONLY — IPs, ports, NAT type, candidates. It
 * never handles a private key, session key, or shared secret.
 *
 * @note This lib does NOT implement WebRTC. Candidate gathering is a PLUGGABLE `gatherer` the app
 * supplies (e.g. one built on `RTCPeerConnection` purely to enumerate local candidates, or one that
 * reports statically-known addresses). The lib only orchestrates + submits.
 *
 * @example
 * ```js
 * import { NetworkDiscoveryClient } from "../lib/networkDiscovery.js";
 * const nd = new NetworkDiscoveryClient({ axios, deviceId, gatherer: myCandidateGatherer });
 * const profile = await nd.discover();      // gather + submit → Network Profile
 * nd.onNetworkChange(() => nd.refresh());   // auto re-discover when the network changes
 * ```
 */

/** NAT types (mirrors the server). */
export const NatType = Object.freeze({
  NO_NAT: "no-nat",
  CONE: "cone",
  SYMMETRIC: "symmetric",
  BLOCKED: "blocked",
  UNKNOWN: "unknown",
});

/** Candidate types (mirrors the server). */
export const CandidateType = Object.freeze({ HOST: "host", SERVER_REFLEXIVE: "srflx", PEER_REFLEXIVE: "prflx", RELAY: "relay" });

/**
 * A stateful client that owns this device's network profile.
 */
export class NetworkDiscoveryClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios
   * @param {string} deps.deviceId this device's stable id
   * @param {{ gather: () => Promise<{ interfaces?: object[], candidates?: object[], stunResults?: object[] }> }} [deps.gatherer]
   *   an app-supplied candidate gatherer (optional; if omitted, the server runs discovery)
   * @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("NetworkDiscoveryClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.gatherer = deps.gatherer ?? null;
    this.options = deps.options ?? {};
    /** @type {object|null} the current profile */
    this.profile = null;
    this._changeHandlers = new Set();
    this._boundNetworkListener = null;
  }

  // === discovery ===========================================================

  /**
   * Discover the device's network: gather signals (if a gatherer is set) + submit to the server.
   * @param {{ ttlMs?: number }} [opts] @returns {Promise<object|null>} the Network Profile
   */
  async discover(opts = {}) {
    const signals = this.gatherer ? await this._safeGather() : {};
    try {
      const { data } = await this.axios.post("/api/network-discovery/generate", { deviceId: this.deviceId, ttlMs: opts.ttlMs, ...signals });
      if (data?.success) {
        this.profile = data.profile;
        this._emitChange({ type: "discovered", profile: data.profile });
        return data.profile;
      }
    } catch (error) {
      console.warn("[netdisc] discover failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  /** Refresh the device's network profile (re-gather + re-submit). */
  async refresh() {
    const signals = this.gatherer ? await this._safeGather() : {};
    try {
      const { data } = await this.axios.post("/api/network-discovery/refresh", { deviceId: this.deviceId, ...signals });
      if (data?.success) {
        this.profile = data.profile;
        this._emitChange({ type: "refreshed", profile: data.profile });
        return data.profile;
      }
    } catch (error) {
      console.warn("[netdisc] refresh failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  // === reads ===============================================================

  /** The device's current profile (from the server). */
  async getProfile() {
    try {
      const { data } = await this.axios.get(`/api/network-discovery/device/${this.deviceId}`);
      if (data?.success) this.profile = data.profile;
      return data?.profile ?? null;
    } catch {
      return this.profile;
    }
  }

  /** The device's non-expired candidates. */
  async getCandidates() {
    try {
      const { data } = await this.axios.get(`/api/network-discovery/device/${this.deviceId}/candidates`);
      return data?.candidates ?? [];
    } catch {
      return this.profile?.candidates ?? [];
    }
  }

  /** The device's NAT info. */
  async getNatInfo() {
    try {
      const { data } = await this.axios.get(`/api/network-discovery/device/${this.deviceId}/nat`);
      return data?.nat ?? null;
    } catch {
      return null;
    }
  }

  /** Discovery diagnostics + history. */
  async getDiagnostics() {
    try {
      const { data } = await this.axios.get(`/api/network-discovery/device/${this.deviceId}/diagnostics`);
      return data?.diagnostics ?? null;
    } catch {
      return null;
    }
  }

  // === live network-change tracking ========================================

  /**
   * Auto-detect network changes (online/offline + `navigator.connection`) and notify. Wire this to
   * `refresh()` so the profile stays current. @returns {() => void} unsubscribe
   */
  onNetworkChange(handler) {
    this._changeHandlers.add(handler);
    if (!this._boundNetworkListener && typeof window !== "undefined") {
      const listener = () => this._emitChange({ type: "network-change" });
      window.addEventListener?.("online", listener);
      window.addEventListener?.("offline", listener);
      navigator?.connection?.addEventListener?.("change", listener);
      this._boundNetworkListener = listener;
    }
    return () => this._changeHandlers.delete(handler);
  }

  // === FUTURE hook (Sprint 2 · ICE) ========================================

  /**
   * FUTURE (Sprint 2 · ICE): hand the gathered candidates + NAT type to an ICE agent for connectivity
   * checks + connection establishment. Inert in Sprint 1 — it returns the discovery result; it opens
   * nothing. @returns {{ candidates: object[], natType: string }|null}
   */
  getConnectionInputs() {
    if (!this.profile) return null;
    return { candidates: this.profile.candidates ?? [], natType: this.profile.natType ?? NatType.UNKNOWN };
  }

  // === internals ===========================================================

  async _safeGather() {
    try {
      return (await this.gatherer.gather()) ?? {};
    } catch (error) {
      console.warn("[netdisc] candidate gathering failed:", error?.message ?? error);
      return {};
    }
  }

  _emitChange(event) {
    for (const h of this._changeHandlers) {
      try {
        h(event);
      } catch (error) {
        console.warn("[netdisc] change handler threw:", error?.message ?? error);
      }
    }
  }
}

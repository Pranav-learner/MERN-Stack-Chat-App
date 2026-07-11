/**
 * Client Endpoint Selection integration (Layer 6, Sprint 5).
 *
 * Turns a set of candidate devices (from a PDP discovery run) into an OPTIMIZED, failover-ready
 * connection plan: it displays the active (primary) device, the fallback devices, the preferred
 * endpoint, and lets the app refresh the plan, react to selection updates, and fail over. It
 * produces a PLAN only — it establishes NO connection (no NAT traversal, ICE, WebRTC, or P2P; that
 * is Layer 7, for which the plan is the input).
 *
 * @security Handles PUBLIC control-plane metadata ONLY — device ids, public identities, presence
 * status, negotiated versions/transports/flags, scores. It never handles a private key, session
 * key, or shared secret.
 *
 * @example
 * ```js
 * import { EndpointSelectionClient } from "../lib/endpointSelection.js";
 * const es = new EndpointSelectionClient({ axios, requesterDevice: deviceId });
 * const plan = await es.generatePlan(peerId, candidates);
 * showActiveDevice(plan.primaryEndpoint);       // display active device
 * // ... if a connection attempt fails ...
 * const next = await es.failover(plan.planId);  // promote a fallback
 * ```
 */

/** Selection policies (mirrors the server). */
export const SelectionPolicy = Object.freeze({
  HIGHEST_SCORE: "highest-score",
  MOST_RECENTLY_ACTIVE: "most-recently-active",
  PREFERRED_PLATFORM: "preferred-platform",
  LOWEST_LATENCY: "lowest-latency",
  BATTERY_FRIENDLY: "battery-friendly",
  DESKTOP_PREFERRED: "desktop-preferred",
  MOBILE_PREFERRED: "mobile-preferred",
  MANUAL_PREFERENCE: "manual-preference",
});

/** A stateful client that generates + tracks connection plans per peer. */
export class EndpointSelectionClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios
   * @param {string} deps.requesterDevice this device's stable id (the connection origin)
   * @param {{ policy?: string }} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.requesterDevice) throw new Error("EndpointSelectionClient requires { axios, requesterDevice }");
    this.axios = deps.axios;
    this.requesterDevice = String(deps.requesterDevice);
    this.options = deps.options ?? {};
    /** @type {Map<string, object>} peerId → current plan */
    this._plans = new Map();
  }

  // === plan generation =====================================================

  /**
   * Generate an optimized connection plan for a peer from candidate devices.
   * @param {string} peerId @param {object[]} candidates devices to evaluate (from a PDP run)
   * @param {{ policy?: string, preferredDeviceId?: string, preferredPlatform?: string, maxFallbacks?: number, useCache?: boolean }} [opts]
   * @returns {Promise<object|null>} the connection plan
   */
  async generatePlan(peerId, candidates, opts = {}) {
    try {
      const { data } = await this.axios.post("/api/endpoint-selection/plan", {
        requesterDevice: this.requesterDevice,
        targetUser: peerId,
        candidates,
        policy: opts.policy ?? this.options.policy,
        preferredDeviceId: opts.preferredDeviceId,
        preferredPlatform: opts.preferredPlatform,
        maxFallbacks: opts.maxFallbacks,
        useCache: opts.useCache,
      });
      if (data?.success) {
        this._plans.set(String(peerId), data.plan);
        return data.plan;
      }
    } catch (error) {
      console.warn("[endpoint] generatePlan failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  /** Rank a peer's candidate devices (no plan) — for a device chooser UI. */
  async rankDevices(peerId, candidates, policy) {
    try {
      const { data } = await this.axios.post("/api/endpoint-selection/rank", { targetUser: peerId, candidates, policy: policy ?? this.options.policy });
      return data?.success ? data.ranking : [];
    } catch {
      return [];
    }
  }

  // === active device + fallbacks ===========================================

  /** The active (primary) endpoint of a peer's current plan (no network). */
  getActiveDevice(peerId) {
    return this._plans.get(String(peerId))?.primaryEndpoint ?? null;
  }

  /** The fallback devices of a peer's current plan (no network). */
  getFallbackDevices(peerId) {
    return this._plans.get(String(peerId))?.fallbackEndpoints ?? [];
  }

  /** The preferred transport of a peer's current plan (no network). */
  getPreferredTransport(peerId) {
    return this._plans.get(String(peerId))?.preferredTransport ?? null;
  }

  /** The cached plan for a peer (no network). */
  getCachedPlan(peerId) {
    return this._plans.get(String(peerId)) ?? null;
  }

  // === lifecycle ===========================================================

  /** Fail over a plan to the next fallback endpoint. */
  async failover(planId, reason) {
    try {
      const { data } = await this.axios.post(`/api/endpoint-selection/${planId}/failover`, { reason });
      if (data?.success) {
        this._rememberByPlanId(data.plan);
        return data.plan;
      }
    } catch (error) {
      console.warn("[endpoint] failover failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  /** Refresh a plan's routing from fresh candidate devices (plan refresh). */
  async refreshPlan(planId, candidates) {
    try {
      const { data } = await this.axios.post(`/api/endpoint-selection/${planId}/refresh`, { candidates });
      if (data?.success) {
        this._rememberByPlanId(data.plan);
        return data.plan;
      }
    } catch (error) {
      console.warn("[endpoint] refresh failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  /** Report the outcome of a connection attempt (feeds server-side reliability). */
  async recordOutcome(planId, deviceId, outcome) {
    try {
      const { data } = await this.axios.post(`/api/endpoint-selection/${planId}/outcome`, { deviceId, outcome });
      return data?.success ?? false;
    } catch {
      return false;
    }
  }

  // === FUTURE hook (Layer 7) ===============================================

  /**
   * FUTURE (Layer 7 · NAT Traversal): hand a plan's ordered endpoints + retry strategy to a
   * connection establisher. Inert in Sprint 5 — it returns the ordering to try; it opens nothing.
   * @param {string} peerId @returns {{ priorityOrder: string[], preferredTransport: string|null, retryStrategy: object }|null}
   */
  getConnectionStrategy(peerId) {
    const plan = this.getCachedPlan(peerId);
    if (!plan) return null;
    return { priorityOrder: plan.priorityOrder ?? [], preferredTransport: plan.preferredTransport ?? null, retryStrategy: plan.retryStrategy ?? {} };
  }

  /** Clear cached plans (e.g. on logout). */
  clear() {
    this._plans.clear();
  }

  /** @private Re-cache a plan under its target user after an update. */
  _rememberByPlanId(plan) {
    if (plan?.targetUser) this._plans.set(String(plan.targetUser), plan);
  }
}

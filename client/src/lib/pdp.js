/**
 * Client Peer Discovery Protocol integration (Layer 6, Sprint 4).
 *
 * Wraps the unified discovery workflow: from a target user, it produces a **connection plan** —
 * which of the peer's device(s) to connect to and how (preferred transport, versions, feature
 * flags). It tracks workflow progress, handles failure + retry, and caches plans. It produces a
 * PLAN only — it establishes NO connection (no NAT traversal, ICE, WebRTC, or P2P; that is Layer 7,
 * for which the returned plan is the input).
 *
 * @security Handles PUBLIC control-plane metadata ONLY — ids, public identities, presence status,
 * negotiated versions/transports/flags. It never handles a private key, session key, or shared
 * secret.
 *
 * @example
 * ```js
 * import { PdpClient } from "../lib/pdp.js";
 * const pdp = new PdpClient({ axios, requesterDevice: deviceId });
 * const plan = await pdp.discover(peerId);
 * if (plan) connectVia(plan.primaryDeviceId, plan.preferredTransport); // Layer 7 establishes it
 * ```
 */

/** PDP workflow states (mirrors the server). */
export const PdpState = Object.freeze({
  CREATED: "created",
  RESOLVING: "resolving",
  NEGOTIATING: "negotiating",
  PLANNING: "planning",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  RECOVERY: "recovery",
});

/** Selection policies (mirrors the server). */
export const SelectionPolicy = Object.freeze({
  CAPABILITY_SCORE: "capability-score",
  NEWEST_ACTIVE: "newest-active",
  HIGHEST_PRIORITY: "highest-priority",
  PLATFORM_PREFERENCE: "platform-preference",
  USER_PREFERENCE: "user-preference",
  LOWEST_LATENCY: "lowest-latency",
});

const TERMINAL = new Set([PdpState.COMPLETED, PdpState.FAILED, PdpState.CANCELLED, PdpState.EXPIRED]);
const RECOVERABLE_REASONS = new Set(["no-active-devices", "presence-conflict", "internal-error", "expired-session"]);

/** A stateful client that runs discoveries + caches connection plans per peer. */
export class PdpClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios
   * @param {string} deps.requesterDevice this device's stable id (the connection origin)
   * @param {{ selectionPolicy?: string, transportPolicy?: string, maxRetries?: number }} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.requesterDevice) throw new Error("PdpClient requires { axios, requesterDevice }");
    this.axios = deps.axios;
    this.requesterDevice = String(deps.requesterDevice);
    this.options = deps.options ?? {};
    /** @type {Map<string, object>} peerId → last connection plan */
    this._plans = new Map();
  }

  // === discovery ===========================================================

  /**
   * Run the full discovery protocol for a peer → a connection plan. Returns null on failure (see
   * {@link lastSession} for the failure reason).
   * @param {string} peerId @param {{ selectionPolicy?: string, transportPolicy?: string, targetDevices?: string[], useCache?: boolean }} [opts]
   * @returns {Promise<object|null>} the connection plan
   */
  async discover(peerId, opts = {}) {
    try {
      const { data } = await this.axios.post("/api/pdp/discover", {
        requesterDevice: this.requesterDevice,
        targetUser: peerId,
        selectionPolicy: opts.selectionPolicy ?? this.options.selectionPolicy,
        transportPolicy: opts.transportPolicy ?? this.options.transportPolicy,
        targetDevices: opts.targetDevices,
        useCache: opts.useCache,
      });
      if (data?.success) {
        this._lastSession = data.session;
        if (data.plan) this._plans.set(String(peerId), data.plan);
        return data.plan ?? null;
      }
    } catch (error) {
      this._lastSession = error?.response?.data ?? null;
      console.warn("[pdp] discover failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return null;
  }

  /**
   * Discover a peer with automatic retry of RECOVERABLE failures (e.g. the peer's devices are
   * briefly offline). Retries via the server's recover endpoint.
   * @param {string} peerId @param {{ maxRetries?: number, retryDelayMs?: number }} [opts]
   * @returns {Promise<object|null>}
   */
  async discoverWithRetry(peerId, opts = {}) {
    const maxRetries = opts.maxRetries ?? this.options.maxRetries ?? 2;
    const delay = opts.retryDelayMs ?? 500;
    let plan = await this.discover(peerId, { useCache: false });
    let attempts = 0;
    while (!plan && attempts < maxRetries && this._lastSession && RECOVERABLE_REASONS.has(this._lastSession.failureReason)) {
      attempts++;
      await new Promise((r) => setTimeout(r, delay));
      plan = await this._recover(this._lastSession.discoveryId);
    }
    return plan;
  }

  /** Resolve just the preferred device + transport for a peer (lighter than a full plan). */
  async resolvePreferred(peerId, opts = {}) {
    try {
      const { data } = await this.axios.post("/api/pdp/resolve-preferred", { requesterDevice: this.requesterDevice, targetUser: peerId, selectionPolicy: opts.selectionPolicy });
      return data?.success ? data.preferred : null;
    } catch (error) {
      console.warn("[pdp] resolvePreferred failed:", error?.response?.data?.message ?? error?.message ?? error);
      return null;
    }
  }

  /** Resolve which of a peer's devices are reachable (no session created). */
  async resolveDevices(peerId) {
    try {
      const { data } = await this.axios.post("/api/pdp/resolve-devices", { requesterDevice: this.requesterDevice, targetUser: peerId });
      return data?.success ? data.devices : [];
    } catch {
      return [];
    }
  }

  // === workflow progress ===================================================

  /**
   * Poll a discovery's status until it reaches a terminal state (or times out). Useful when a
   * caller starts a discovery and wants to track workflow progress.
   * @param {string} discoveryId @param {{ intervalMs?: number, timeoutMs?: number, onProgress?: (s:object)=>void }} [opts]
   * @returns {Promise<object|null>} the terminal status
   */
  async trackProgress(discoveryId, opts = {}) {
    const intervalMs = opts.intervalMs ?? 250;
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    let last = null;
    while (Date.now() < deadline) {
      last = await this._status(discoveryId);
      if (last) {
        opts.onProgress?.(last);
        if (TERMINAL.has(last.state)) return last;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
  }

  /** The connection plan for a discovery run. */
  async getConnectionPlan(discoveryId) {
    try {
      const { data } = await this.axios.get(`/api/pdp/${discoveryId}/plan`);
      return data?.success ? data.plan : null;
    } catch {
      return null;
    }
  }

  /** The caller's discovery history. */
  async history(opts = {}) {
    try {
      const { data } = await this.axios.get("/api/pdp", { params: opts });
      return data?.discoveries ?? [];
    } catch {
      return [];
    }
  }

  /** Cancel an active discovery. */
  async cancel(discoveryId, reason) {
    try {
      const { data } = await this.axios.post(`/api/pdp/${discoveryId}/cancel`, { reason });
      return data?.session ?? null;
    } catch {
      return null;
    }
  }

  // === cache + FUTURE hooks ================================================

  /** The cached connection plan for a peer (no network). */
  getCachedPlan(peerId) {
    return this._plans.get(String(peerId)) ?? null;
  }

  /** The session (or error body) from the most recent discover call. */
  get lastSession() {
    return this._lastSession ?? null;
  }

  /**
   * FUTURE (Layer 7 · NAT Traversal): hand a connection plan to a connection establisher. Inert in
   * Sprint 4 — it returns the plan's transport strategy; it opens nothing.
   * @param {string} peerId @returns {{ primaryDeviceId: string|null, preferredTransport: string|null, fallbackTransports: string[] }|null}
   */
  getConnectionStrategy(peerId) {
    const plan = this.getCachedPlan(peerId);
    if (!plan) return null;
    return { primaryDeviceId: plan.primaryDeviceId ?? null, preferredTransport: plan.preferredTransport ?? null, fallbackTransports: plan.fallbackTransports ?? [] };
  }

  /** Clear cached plans (e.g. on logout). */
  clear() {
    this._plans.clear();
  }

  // === internals ===========================================================

  async _status(discoveryId) {
    try {
      const { data } = await this.axios.get(`/api/pdp/${discoveryId}/status`);
      return data?.success ? data.status : null;
    } catch {
      return null;
    }
  }

  async _recover(discoveryId) {
    try {
      const { data } = await this.axios.post(`/api/pdp/${discoveryId}/recover`, {});
      if (data?.success) {
        this._lastSession = data.session;
        return data.plan ?? null;
      }
    } catch (error) {
      this._lastSession = error?.response?.data ?? this._lastSession;
    }
    return null;
  }
}

/**
 * Client Presence integration (Layer 6, Sprint 2).
 *
 * Makes the client a first-class participant in the real-time presence control plane: it
 * automatically registers this device's presence, keeps it alive with heartbeats, handles
 * reconnects, lets the user change status, and tracks which of a peer's devices are currently
 * reachable. It answers *whether* devices are reachable — it establishes NO peer connection
 * (no capability exchange, NAT traversal, WebRTC, or P2P — those are future sprints).
 *
 * @security Handles PUBLIC presence + advertisement metadata ONLY — user/device/presence ids,
 * public identity keys + fingerprints, statuses, timestamps. It never handles a private key,
 * session key, message key, or shared secret.
 *
 * @example
 * ```js
 * import { PresenceClient } from "../lib/presence.js";
 * const presence = new PresenceClient({ axios, socket, deviceId });
 * await presence.start();            // register + begin heartbeats
 * presence.onChange((e) => refreshRoster(e));
 * await presence.setStatus("away");
 * // ... on logout ...
 * await presence.stop();
 * ```
 */

/** Presence statuses (mirrors the server). */
export const PresenceStatus = Object.freeze({
  ONLINE: "online",
  AWAY: "away",
  BUSY: "busy",
  INVISIBLE: "invisible",
  RECONNECTING: "reconnecting",
  DISCONNECTED: "disconnected",
  OFFLINE: "offline",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
});

const REACHABLE = new Set([PresenceStatus.ONLINE, PresenceStatus.AWAY, PresenceStatus.BUSY, PresenceStatus.INVISIBLE]);

/** Whether a status means the device is reachable. */
export function isReachable(status) {
  return REACHABLE.has(status);
}

/**
 * A stateful client that owns this device's presence lifecycle + a cache of peers' reachability.
 */
export class PresenceClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios
   * @param {import("socket.io-client").Socket} [deps.socket] optional socket for cheap heartbeats + live updates
   * @param {string} deps.deviceId this device's stable id
   * @param {{ status?: string, platform?: string, softwareVersion?: string, identityId?: string, heartbeatMs?: number }} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("PresenceClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.socket = deps.socket ?? null;
    this.deviceId = String(deps.deviceId);
    this.options = deps.options ?? {};
    this.heartbeatMs = this.options.heartbeatMs ?? 15_000;
    /** @type {object|null} this device's presence record */
    this.self = null;
    /** @type {Map<string, object[]>} peerId → reachable device advertisements */
    this._peers = new Map();
    this._timer = null;
    this._changeHandlers = new Set();
    this._boundSocketHandlers = null;
  }

  // === lifecycle ===========================================================

  /**
   * Register this device's presence and begin heartbeating. Idempotent — calling `start()` twice
   * refreshes rather than double-registers.
   * @returns {Promise<object|null>} this device's presence record
   */
  async start() {
    try {
      const { data } = await this.axios.post("/api/presence/register", {
        deviceId: this.deviceId,
        status: this.options.status ?? PresenceStatus.ONLINE,
        platform: this.options.platform,
        softwareVersion: this.options.softwareVersion,
        identityId: this.options.identityId,
      });
      if (data?.success) this.self = data.presence;
    } catch (error) {
      // A 409 duplicate means we're already registered + reachable — that's fine.
      if (error?.response?.status !== 409) {
        console.warn("[presence] register failed:", error?.response?.data?.message ?? error?.message ?? error);
      }
    }
    this._startHeartbeat();
    this._bindSocket();
    return this.self;
  }

  /** Stop heartbeating and mark this device cleanly offline. */
  async stop() {
    this._stopHeartbeat();
    this._unbindSocket();
    if (this.self?.presenceId) {
      try {
        await this.axios.post(`/api/presence/${this.self.presenceId}/offline`, {});
      } catch (error) {
        console.warn("[presence] offline failed:", error?.response?.data?.message ?? error?.message ?? error);
      }
    }
  }

  /**
   * Send a single heartbeat now (also called on the interval). Prefers the socket channel when
   * available (cheaper), falling back to REST.
   * @returns {Promise<void>}
   */
  async heartbeat() {
    if (this.socket?.connected) {
      this.socket.emit("presence:heartbeat");
      return;
    }
    if (!this.self?.presenceId) return;
    try {
      const { data } = await this.axios.post(`/api/presence/${this.self.presenceId}/heartbeat`, {});
      if (data?.success) this.self = data.presence;
    } catch (error) {
      console.warn("[presence] heartbeat failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
  }

  /**
   * Change this device's user-visible status (online / away / busy / invisible). Uses the socket
   * when connected, else REST.
   * @param {string} status @returns {Promise<object|null>}
   */
  async setStatus(status) {
    if (this.socket?.connected) {
      this.socket.emit("presence:status", { status });
      return this.self;
    }
    if (!this.self?.presenceId) return null;
    try {
      const { data } = await this.axios.patch(`/api/presence/${this.self.presenceId}`, { status });
      if (data?.success) this.self = data.presence;
      return this.self;
    } catch (error) {
      console.warn("[presence] setStatus failed:", error?.response?.data?.message ?? error?.message ?? error);
      return null;
    }
  }

  /**
   * Handle a reconnect (e.g. the socket came back): re-register + heartbeat so a device that was
   * marked disconnected/expired recovers to online.
   * @returns {Promise<object|null>}
   */
  async reconnect() {
    return this.start();
  }

  // === peer reachability ===================================================

  /**
   * Resolve which of a peer's devices are currently reachable (device advertisements).
   * @param {string} peerId @returns {Promise<object[]>}
   */
  async getReachableDevices(peerId) {
    try {
      const { data } = await this.axios.get(`/api/presence/lookup/${peerId}`);
      if (data?.success) {
        this._peers.set(String(peerId), data.devices ?? []);
        return data.devices ?? [];
      }
    } catch (error) {
      console.warn("[presence] lookup failed:", error?.response?.data?.message ?? error?.message ?? error);
    }
    return this._peers.get(String(peerId)) ?? [];
  }

  /** A peer's visible-online devices (compact status views). */
  async getOnlineDevices(peerId) {
    try {
      const { data } = await this.axios.get(`/api/presence/online/${peerId}`);
      return data?.online ?? [];
    } catch {
      return [];
    }
  }

  /** A peer device's last-seen view. */
  async getLastSeen(peerId, deviceId) {
    try {
      const { data } = await this.axios.get(`/api/presence/last-seen/${peerId}/${deviceId}`);
      return data?.lastSeen ?? null;
    } catch {
      return null;
    }
  }

  /** Whether a peer has any reachable device (from the local cache; call getReachableDevices first). */
  isPeerReachable(peerId) {
    return (this._peers.get(String(peerId)) ?? []).length > 0;
  }

  /** The cached reachable-device list for a peer (no network). */
  getCachedDevices(peerId) {
    return this._peers.get(String(peerId)) ?? [];
  }

  // === live updates ========================================================

  /**
   * Subscribe to live presence changes (from the socket `presenceChanged` broadcast + this
   * device's own `presenceSelf`). @param {(event: object) => void} handler @returns {() => void}
   */
  onChange(handler) {
    this._changeHandlers.add(handler);
    return () => this._changeHandlers.delete(handler);
  }

  // === FUTURE hooks (inert — later Layer 6 sprints fill these) =============

  /**
   * FUTURE (Layer 6 · Capability Exchange sprint): a reachable device's advertised capabilities.
   * Inert in Sprint 2 — an advertisement only says a device is reachable, not how. Returns the
   * reserved placeholder from a cached advertisement.
   * @param {string} peerId @param {string} deviceId @returns {object|null}
   */
  getDeviceCapabilities(peerId, deviceId) {
    const dev = this.getCachedDevices(peerId).find((d) => d.deviceId === deviceId);
    return dev?.connection ?? null; // inert placeholder until Sprint 3
  }

  // === internals ===========================================================

  _startHeartbeat() {
    this._stopHeartbeat();
    this._timer = setInterval(() => void this.heartbeat(), this.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _bindSocket() {
    if (!this.socket || this._boundSocketHandlers) return;
    const onSelf = (record) => {
      this.self = record;
      this._emitChange({ type: "presenceSelf", record });
    };
    const onChanged = (event) => this._emitChange(event);
    const onReconnect = () => void this.reconnect();
    this.socket.on("presenceSelf", onSelf);
    this.socket.on("presenceChanged", onChanged);
    this.socket.on("connect", onReconnect);
    this._boundSocketHandlers = { onSelf, onChanged, onReconnect };
  }

  _unbindSocket() {
    if (!this.socket || !this._boundSocketHandlers) return;
    const { onSelf, onChanged, onReconnect } = this._boundSocketHandlers;
    this.socket.off("presenceSelf", onSelf);
    this.socket.off("presenceChanged", onChanged);
    this.socket.off("connect", onReconnect);
    this._boundSocketHandlers = null;
  }

  _emitChange(event) {
    // A peer's device changed → drop its cached reachability so the next read re-resolves.
    if (event?.userId) this._peers.delete(String(event.userId));
    for (const h of this._changeHandlers) {
      try {
        h(event);
      } catch (error) {
        console.warn("[presence] change handler threw:", error?.message ?? error);
      }
    }
  }
}

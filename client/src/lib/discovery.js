/**
 * Client Peer Discovery integration (Layer 6, Sprint 1).
 *
 * Makes the client aware of the networking CONTROL PLANE: it can ask the server "who is
 * this peer and which devices do they have?", track discovery sessions + their lifecycle
 * state, keep a small per-peer history/cache of resolved discovery metadata, and expose
 * FUTURE hooks for presence / capability / transport that later Layer 6 sprints will fill
 * in.
 *
 * @security This module handles PUBLIC discovery metadata ONLY — peer/user/device ids,
 * public identity/device keys + fingerprints, lifecycle states. It never handles a private
 * key, session key, message key, or shared secret, and it establishes NO peer connection
 * (no presence, capability exchange, NAT traversal, WebRTC, or P2P — those are future
 * sprints). Discovery answers WHO/WHICH, never HOW to reach a peer.
 *
 * @example
 * ```js
 * import { lookupUser, awaitResolved } from "../lib/discovery.js";
 * const { session, metadata } = await lookupUser(axios, peerId);
 * if (metadata) console.log("peer devices:", metadata.deviceIds);
 * ```
 */

/** Discovery lifecycle states (mirrors the server's state machine). */
export const DiscoveryState = Object.freeze({
  CREATED: "created",
  PENDING: "pending",
  SEARCHING: "searching",
  RESOLVED: "resolved",
  FAILED: "failed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
});

const TERMINAL = new Set([
  DiscoveryState.RESOLVED,
  DiscoveryState.FAILED,
  DiscoveryState.EXPIRED,
  DiscoveryState.CANCELLED,
  DiscoveryState.COMPLETED,
]);

/** In-memory cache of the most-recent resolved discovery metadata, keyed by peer id. */
const metadataByPeer = new Map();
/** Bounded per-peer discovery history (most recent first). */
const historyByPeer = new Map();
const HISTORY_LIMIT = 20;

function remember(peerId, session, metadata) {
  const key = String(peerId);
  if (metadata) metadataByPeer.set(key, metadata);
  const prior = historyByPeer.get(key) ?? [];
  historyByPeer.set(key, [{ session, metadata, at: Date.now() }, ...prior].slice(0, HISTORY_LIMIT));
}

// === lookups ===============================================================

/**
 * Look up a peer → their public identity + all discoverable devices. Creates a discovery
 * session server-side and returns the resolved session (or a FAILED session with a
 * `failureReason` for an unknown peer).
 * @param {import("axios").AxiosInstance} axios
 * @param {string} targetUser peer user id
 * @param {{ requesterDevice?: string, ttlMs?: number, metadata?: object }} [options]
 * @returns {Promise<{ session: object|null, metadata: object|null }>}
 */
export async function lookupUser(axios, targetUser, options = {}) {
  try {
    const { data } = await axios.post("/api/discovery/lookup/user", { targetUser, ...options });
    if (data?.success) {
      remember(targetUser, data.session, data.metadata);
      return { session: data.session, metadata: data.metadata ?? null };
    }
  } catch (error) {
    console.warn("[discovery] lookupUser failed:", error?.response?.data?.message ?? error?.message ?? error);
  }
  return { session: null, metadata: null };
}

/**
 * Look up a single device of a peer.
 * @param {import("axios").AxiosInstance} axios @param {string} targetUser @param {string} deviceId
 * @param {{ requesterDevice?: string, ttlMs?: number }} [options]
 * @returns {Promise<{ session: object|null, metadata: object|null }>}
 */
export async function lookupDevice(axios, targetUser, deviceId, options = {}) {
  try {
    const { data } = await axios.post("/api/discovery/lookup/device", { targetUser, deviceId, ...options });
    if (data?.success) {
      remember(targetUser, data.session, data.metadata);
      return { session: data.session, metadata: data.metadata ?? null };
    }
  } catch (error) {
    console.warn("[discovery] lookupDevice failed:", error?.response?.data?.message ?? error?.message ?? error);
  }
  return { session: null, metadata: null };
}

/**
 * Look up a subset (or all) of a peer's devices.
 * @param {import("axios").AxiosInstance} axios @param {string} targetUser
 * @param {string[]} [deviceIds] empty/omitted = all devices
 * @param {{ requesterDevice?: string, ttlMs?: number }} [options]
 * @returns {Promise<{ session: object|null, metadata: object|null }>}
 */
export async function lookupDevices(axios, targetUser, deviceIds = [], options = {}) {
  try {
    const { data } = await axios.post("/api/discovery/lookup/devices", { targetUser, deviceIds, ...options });
    if (data?.success) {
      remember(targetUser, data.session, data.metadata);
      return { session: data.session, metadata: data.metadata ?? null };
    }
  } catch (error) {
    console.warn("[discovery] lookupDevices failed:", error?.response?.data?.message ?? error?.message ?? error);
  }
  return { session: null, metadata: null };
}

// === session staging + status ==============================================

/**
 * Stage a discovery session without resolving it (CREATED → PENDING). Useful to drive a
 * lookup explicitly, e.g. poll its status separately.
 * @param {import("axios").AxiosInstance} axios @param {string} targetUser
 * @param {{ targetDevices?: string[], requesterDevice?: string, ttlMs?: number }} [options]
 * @returns {Promise<object|null>} the staged session
 */
export async function createSession(axios, targetUser, options = {}) {
  try {
    const { data } = await axios.post("/api/discovery/sessions", { targetUser, ...options });
    return data?.session ?? null;
  } catch (error) {
    console.warn("[discovery] createSession failed:", error?.response?.data?.message ?? error?.message ?? error);
    return null;
  }
}

/**
 * Compact status of a discovery session (for polling).
 * @param {import("axios").AxiosInstance} axios @param {string} discoveryId @returns {Promise<object|null>}
 */
export async function getStatus(axios, discoveryId) {
  try {
    const { data } = await axios.get(`/api/discovery/${discoveryId}/status`);
    return data?.status ?? null;
  } catch (error) {
    console.warn("[discovery] getStatus failed:", error?.response?.data?.message ?? error?.message ?? error);
    return null;
  }
}

/**
 * Full discovery session view (optionally with the audit trail).
 * @param {import("axios").AxiosInstance} axios @param {string} discoveryId
 * @param {{ audit?: boolean }} [options] @returns {Promise<object|null>}
 */
export async function getDiscovery(axios, discoveryId, options = {}) {
  try {
    const { data } = await axios.get(`/api/discovery/${discoveryId}`, { params: options.audit ? { audit: "true" } : {} });
    return data?.session ?? null;
  } catch (error) {
    console.warn("[discovery] getDiscovery failed:", error?.response?.data?.message ?? error?.message ?? error);
    return null;
  }
}

/**
 * Poll a discovery session's status until it reaches a terminal state (or times out).
 * @param {import("axios").AxiosInstance} axios @param {string} discoveryId
 * @param {{ intervalMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<object|null>} the terminal status (or the last status seen)
 */
export async function awaitResolved(axios, discoveryId, options = {}) {
  const intervalMs = options.intervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getStatus(axios, discoveryId);
    if (last && TERMINAL.has(last.state)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

// === lifecycle actions =====================================================

/**
 * Cancel an active discovery.
 * @param {import("axios").AxiosInstance} axios @param {string} discoveryId @param {string} [reason]
 * @returns {Promise<object|null>} the cancelled session
 */
export async function cancelDiscovery(axios, discoveryId, reason) {
  try {
    const { data } = await axios.post(`/api/discovery/${discoveryId}/cancel`, { reason });
    return data?.session ?? null;
  } catch (error) {
    console.warn("[discovery] cancel failed:", error?.response?.data?.message ?? error?.message ?? error);
    return null;
  }
}

/**
 * Mark a resolved discovery completed (its result was consumed by the app).
 * @param {import("axios").AxiosInstance} axios @param {string} discoveryId @returns {Promise<object|null>}
 */
export async function completeDiscovery(axios, discoveryId) {
  try {
    const { data } = await axios.post(`/api/discovery/${discoveryId}/complete`, {});
    return data?.session ?? null;
  } catch (error) {
    console.warn("[discovery] complete failed:", error?.response?.data?.message ?? error?.message ?? error);
    return null;
  }
}

/**
 * List the caller's discoveries.
 * @param {import("axios").AxiosInstance} axios @param {{ activeOnly?: boolean }} [options]
 * @returns {Promise<object[]>}
 */
export async function listDiscoveries(axios, options = {}) {
  try {
    const { data } = await axios.get("/api/discovery", { params: options.activeOnly ? { active: "true" } : {} });
    return data?.discoveries ?? [];
  } catch (error) {
    console.warn("[discovery] list failed:", error?.response?.data?.message ?? error?.message ?? error);
    return [];
  }
}

// === registry self-service =================================================

/**
 * Register one of the caller's OWN devices as discoverable (public key only).
 * @param {import("axios").AxiosInstance} axios
 * @param {{ deviceId: string, publicKey: string, fingerprint?: string, identityId?: string, algorithm?: string, name?: string, platform?: string }} device
 * @returns {Promise<object|null>} the stored descriptor
 */
export async function registerOwnDevice(axios, device) {
  try {
    const { data } = await axios.post("/api/discovery/register", device);
    return data?.device ?? null;
  } catch (error) {
    console.warn("[discovery] registerOwnDevice failed:", error?.response?.data?.message ?? error?.message ?? error);
    return null;
  }
}

/**
 * Deregister one of the caller's own devices.
 * @param {import("axios").AxiosInstance} axios @param {string} deviceId @returns {Promise<boolean>}
 */
export async function deregisterOwnDevice(axios, deviceId) {
  try {
    const { data } = await axios.post("/api/discovery/deregister", { deviceId });
    return !!data?.removed;
  } catch (error) {
    console.warn("[discovery] deregisterOwnDevice failed:", error?.response?.data?.message ?? error?.message ?? error);
    return false;
  }
}

// === cache + history readers (no network) ==================================

/** The most-recent resolved discovery metadata for a peer (no network). */
export function getCachedMetadata(peerId) {
  return metadataByPeer.get(String(peerId)) ?? null;
}

/** The known discoverable device ids for a peer (from cache), or []. */
export function getCachedDeviceIds(peerId) {
  return getCachedMetadata(peerId)?.deviceIds ?? [];
}

/** The bounded discovery history for a peer (most recent first). */
export function getDiscoveryHistory(peerId) {
  return historyByPeer.get(String(peerId)) ?? [];
}

/** Whether a discovery status/session represents a found peer. */
export function isResolved(sessionOrStatus) {
  return sessionOrStatus?.state === DiscoveryState.RESOLVED || sessionOrStatus?.state === DiscoveryState.COMPLETED;
}

/** Whether a discovery status/session has reached a terminal state. */
export function isTerminal(sessionOrStatus) {
  return TERMINAL.has(sessionOrStatus?.state);
}

// === FUTURE hooks (inert placeholders — later Layer 6 sprints fill these) ===

/**
 * FUTURE (Layer 6 · Presence sprint): a peer's presence. Inert in Sprint 1 — discovery
 * never reports whether a peer is online. Returns the reserved placeholder as-is.
 * @param {string} peerId @returns {object|null}
 */
export function getPresence(peerId) {
  return getCachedMetadata(peerId)?.presence ?? null;
}

/**
 * FUTURE (Layer 6 · Capability Exchange sprint): a peer's advertised capabilities. Inert
 * in Sprint 1. @param {string} peerId @returns {object|null}
 */
export function getCapabilities(peerId) {
  return getCachedMetadata(peerId)?.capabilities ?? null;
}

/**
 * FUTURE (Layer 6 · NAT Traversal / WebRTC sprints): a peer's transport reachability
 * (candidates, relays). Inert in Sprint 1 — discovery never advertises HOW to reach a
 * peer. @param {string} peerId @returns {object|null}
 */
export function getTransport(peerId) {
  return getCachedMetadata(peerId)?.transport ?? null;
}

/** Clear the per-peer discovery cache + history (e.g. on logout). */
export function clearDiscoveryCache() {
  metadataByPeer.clear();
  historyByPeer.clear();
}

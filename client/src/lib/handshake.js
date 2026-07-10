/**
 * Client handshake protocol awareness (Layer 4, Sprint 1 — Protocol Foundation).
 *
 * A thin, protocol-aware client for the Secure Handshake System. It lets the app
 * start / accept / reject / cancel / complete / resume / restart handshakes, read a
 * handshake's state, list pending handshakes and history, and discover the server's
 * protocol version + capabilities.
 *
 * @security This module handles PROTOCOL METADATA ONLY. Sprint 1 has NO key
 * exchange, NO shared secret, and NO encryption — a "completed" handshake means the
 * protocol framework agreed on a version and capability set, nothing cryptographic.
 * Private keys never leave the device (they are not touched here at all).
 */

import { getLocalDeviceId, getOrCreateLocalDevice } from "./identity.js";

/** Handshake lifecycle states, mirroring the server's state machine. */
export const HandshakeState = Object.freeze({
  CREATED: "created",
  INITIALIZED: "initialized",
  WAITING: "waiting",
  NEGOTIATING: "negotiating",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  TIMED_OUT: "timed_out",
  REJECTED: "rejected",
  ABORTED: "aborted",
});

/** States in which a handshake is still in flight (worth surfacing as "pending"). */
export const ACTIVE_STATES = Object.freeze(["created", "initialized", "waiting", "negotiating"]);

const HISTORY_KEY = (userId) => `securechat.handshake.history.v1.${userId}`;
const MAX_HISTORY = 50;

/** Ensure the caller's local device id, creating the device if needed. */
async function ensureDeviceId(userId) {
  let deviceId = getLocalDeviceId(userId);
  if (!deviceId) {
    const device = await getOrCreateLocalDevice(userId);
    deviceId = device?.deviceId ?? null;
  }
  return deviceId;
}

/**
 * Start a handshake with another user. Tags the request with this device's id.
 * @param {import("axios").AxiosInstance} axios
 * @param {string} userId the caller's id (for device resolution + history)
 * @param {string} responderId the peer to handshake with
 * @param {{ capabilities?: string[], version?: string, metadata?: object }} [options]
 * @returns {Promise<{ session: object, message: object }>}
 */
export async function startHandshake(axios, userId, responderId, options = {}) {
  const initiatorDevice = await ensureDeviceId(userId);
  const { data } = await axios.post("/api/handshake/start", {
    responderId,
    initiatorDevice,
    version: options.version,
    capabilities: options.capabilities,
    metadata: options.metadata,
  });
  if (data?.success) recordHistory(userId, data.session);
  return data;
}

/** Accept a pending handshake (as the responder). */
export async function acceptHandshake(axios, userId, handshakeId, options = {}) {
  const responderDevice = await ensureDeviceId(userId);
  const { data } = await axios.post(`/api/handshake/${handshakeId}/accept`, {
    responderDevice,
    version: options.version,
    capabilities: options.capabilities,
  });
  if (data?.success) recordHistory(userId, data.session);
  return data;
}

/** Complete a negotiating handshake. */
export async function completeHandshake(axios, userId, handshakeId) {
  const { data } = await axios.post(`/api/handshake/${handshakeId}/complete`);
  if (data?.success) recordHistory(userId, data.session);
  return data;
}

/** Reject a pending handshake (as the responder). */
export async function rejectHandshake(axios, userId, handshakeId, reason) {
  const { data } = await axios.post(`/api/handshake/${handshakeId}/reject`, { reason });
  if (data?.success) recordHistory(userId, data.session);
  return data;
}

/** Cancel a handshake you started (as the initiator). */
export async function cancelHandshake(axios, userId, handshakeId, reason) {
  const { data } = await axios.post(`/api/handshake/${handshakeId}/cancel`, { reason });
  if (data?.success) recordHistory(userId, data.session);
  return data;
}

/** Resume a non-terminal handshake. */
export async function resumeHandshake(axios, handshakeId) {
  const { data } = await axios.post(`/api/handshake/${handshakeId}/resume`);
  return data;
}

/** Restart a terminated handshake (subject to the server's retry budget). */
export async function restartHandshake(axios, userId, handshakeId) {
  const { data } = await axios.post(`/api/handshake/${handshakeId}/restart`);
  if (data?.success) recordHistory(userId, data.session);
  return data;
}

/** Get a single handshake's current status. */
export async function getHandshake(axios, handshakeId) {
  const { data } = await axios.get(`/api/handshake/${handshakeId}`);
  return data?.session ?? null;
}

/**
 * List the caller's handshake sessions, optionally filtered by state.
 * @param {import("axios").AxiosInstance} axios @param {{ state?: string }} [options]
 * @returns {Promise<object[]>}
 */
export async function listSessions(axios, options = {}) {
  const { data } = await axios.get("/api/handshake", {
    params: options.state ? { state: options.state } : {},
  });
  return data?.sessions ?? [];
}

/** The caller's currently-pending (in-flight) handshakes. */
export async function listPending(axios) {
  const sessions = await listSessions(axios);
  return sessions.filter((s) => ACTIVE_STATES.includes(s.state));
}

/** Discover the server's protocol version + advertised capabilities. */
export async function getProtocolInfo(axios) {
  const { data } = await axios.get("/api/handshake/protocol/info");
  return data?.protocol ?? null;
}

// === local history (client-side, public metadata only) ===================

/** Append/update a session in the local history cache (newest first, capped). */
function recordHistory(userId, session) {
  if (!session?.handshakeId) return;
  try {
    const list = readHistory(userId).filter((s) => s.handshakeId !== session.handshakeId);
    list.unshift({
      handshakeId: session.handshakeId,
      initiator: session.initiator,
      responder: session.responder,
      state: session.state,
      protocolVersion: session.protocolVersion,
      updatedAt: session.updatedAt,
    });
    localStorage.setItem(HISTORY_KEY(userId), JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch {
    /* ignore storage errors */
  }
}

/** Read the locally cached handshake history (no network). */
export function readHistory(userId) {
  try {
    const raw = localStorage.getItem(HISTORY_KEY(userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Clear the local handshake history (e.g. on logout). */
export function clearHistory(userId) {
  try {
    localStorage.removeItem(HISTORY_KEY(userId));
  } catch {
    /* ignore */
  }
}

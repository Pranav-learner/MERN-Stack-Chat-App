/**
 * Client session-messaging awareness (Layer 4, Sprint 5).
 *
 * Makes the client aware of the Secure Session backing each conversation. It reads the
 * server's session context for a peer, tracks per-peer transport mode (session vs
 * fallback), and annotates outbound sends — WITHOUT encrypting anything (Layer 5 adds
 * that behind the same API).
 *
 * @security Awareness only. This module reads PUBLIC session metadata (sessionId,
 * keyId, transportMode). It never handles keys or ciphertext. The `secured` flag stays
 * false until Layer 5 wires the client-side encryption interceptor.
 */

/** Transport modes mirrored from the server. */
export const TransportMode = Object.freeze({ SESSION: "session", FALLBACK: "fallback" });

/** In-memory per-peer session context cache (public metadata only). */
const contextByPeer = new Map();

/**
 * Fetch (and cache) the caller's session context with a peer.
 * @param {import("axios").AxiosInstance} axios @param {string} peerId
 * @returns {Promise<object|null>} the session context (resolution, transportMode, keyId, …)
 */
export async function getSessionContext(axios, peerId) {
  try {
    const { data } = await axios.get(`/api/messaging-session/context/${peerId}`);
    if (data?.success) {
      contextByPeer.set(String(peerId), data.context);
      return data.context;
    }
  } catch (error) {
    console.warn("[session] context load failed:", error?.message ?? error);
  }
  return contextByPeer.get(String(peerId)) ?? null;
}

/** The cached session context for a peer (no network). */
export function getCachedContext(peerId) {
  return contextByPeer.get(String(peerId)) ?? null;
}

/** Whether a secure session currently backs the conversation with a peer. */
export function isSessionBacked(peerId) {
  return getCachedContext(peerId)?.transportMode === TransportMode.SESSION;
}

/** A short label for the conversation's transport ("Secure session" / "No session (fallback)"). */
export function transportLabel(peerId) {
  const ctx = getCachedContext(peerId);
  if (!ctx) return "Unknown";
  if (ctx.transportMode === TransportMode.SESSION) return "Secure session";
  return `No session (${ctx.resolution ?? "fallback"})`;
}

/** The caller's messaging session status (enforcement + whether encryption is on). */
export async function getStatus(axios) {
  try {
    const { data } = await axios.get("/api/messaging-session/status");
    return data?.status ?? null;
  } catch {
    return null;
  }
}

/** Aggregate integration stats (for a debug/health panel). */
export async function getStats(axios) {
  try {
    const { data } = await axios.get("/api/messaging-session/stats");
    return data?.stats ?? null;
  } catch {
    return null;
  }
}

/**
 * Send a message, refreshing the session context first so the UI can reflect the
 * transport mode. The server routes the send through the session-aware pipeline; this
 * wrapper simply keeps the client's view in sync and returns both the message + context.
 *
 * @param {import("axios").AxiosInstance} axios @param {string} peerId
 * @param {{ text?: string, image?: string }} body
 * @returns {Promise<{ message: object, session: object }>}
 */
export async function sendMessage(axios, peerId, body) {
  const { data } = await axios.post(`/api/messages/send/${peerId}`, body);
  if (data?.session) contextByPeer.set(String(peerId), data.session);
  return { message: data?.message ?? null, session: data?.session ?? null };
}

/**
 * Subscribe to the socket's session-transport summary (emitted on connect). Lets the
 * client show identity + session readiness for the connection.
 * @param {import("socket.io-client").Socket} socket @param {(summary: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onSessionTransport(socket, handler) {
  socket.on("sessionTransport", handler);
  return () => socket.off("sessionTransport", handler);
}

/** Read the `session` metadata a server attaches to an inbound `newMessage` event. */
export function messageSessionMeta(message) {
  return message?.session ?? { secured: false, transportMode: TransportMode.FALLBACK, fallback: true };
}

/** Clear the per-peer context cache (e.g. on logout). */
export function clearSessionContexts() {
  contextByPeer.clear();
}

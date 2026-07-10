/**
 * @module session-integration/adapters/socketAdapter
 *
 * Makes Socket.IO connections **session-aware** (Layer 4, Sprint 5, Step 6). Building
 * on the Layer 3 identity attachment (`socket.data.identity`), it attaches a session
 * summary + transport readiness to `socket.data.session` and provides an on-demand
 * per-peer resolver for socket message handlers.
 *
 * @security Additive + backward compatible — it does NOT change presence, rooms, or
 * delivery. It attaches PUBLIC session metadata (no keys). No transport encryption.
 */

import { IntegrationEventType, EnforcementMode } from "../types.js";

/**
 * Attach a session-awareness summary to a socket. Reads the connecting user from the
 * Layer 3 identity attachment (or the legacy `query.userId`).
 *
 * @param {import("socket.io").Socket} socket
 * @param {object} deps
 * @param {import("../manager/applicationSessionManager.js").ApplicationSessionManager} deps.appSessions
 * @returns {object} the attached session summary
 * @example
 * ```js
 * io.on("connection", async (socket) => {
 *   await attachSocketIdentity(socket, { service, verifyToken }); // Layer 3
 *   const session = attachSocketSessionContext(socket, { appSessions });
 *   socket.emit("sessionTransport", session);
 * });
 * ```
 */
export function attachSocketSessionContext(socket, deps) {
  const app = deps.appSessions;
  const userId = socket.data?.identity?.userId ?? socket.handshake?.query?.userId ?? null;

  const summary = {
    userId: userId ? String(userId) : null,
    deviceId: socket.data?.identity?.deviceId ?? null,
    handshakeReady: !!socket.data?.identity?.ready,
    enforcement: app.enforcement,
    transportReady: !!userId, // a session-aware transport is ready once we know the user
    // Per-peer session status is resolved on demand (resolvePeer) to avoid scanning.
  };

  socket.data = socket.data ?? {};
  socket.data.session = summary;
  // Expose an on-demand resolver bound to this socket's user.
  socket.data.resolveSessionWith = (peer, options = {}) => app.sessionContext(summary.userId, peer, options);

  app.events.emit(IntegrationEventType.TRANSPORT_READY, { initiator: summary.userId, details: { channel: "socket" } });
  return summary;
}

/**
 * Resolve the session context between a socket's user and a peer (for a socket message
 * handler). Returns a fallback context if the socket has no known user.
 * @param {import("socket.io").Socket} socket @param {string} peer
 * @param {import("../manager/applicationSessionManager.js").ApplicationSessionManager} appSessions
 * @param {{ groupId?: string }} [options]
 */
export async function resolveSocketSession(socket, peer, appSessions, options = {}) {
  const userId = socket.data?.session?.userId ?? socket.data?.identity?.userId ?? null;
  if (!userId) {
    return { resolution: "missing", resolved: false, transportMode: "fallback", fallback: true, initiator: null, peer: peer ? String(peer) : null };
  }
  return appSessions.sessionContext(userId, peer, options);
}

/** Build a session-aware wrapper for a socket event payload (attaches session metadata). */
export function withSessionMetadata(payload, context) {
  return {
    ...payload,
    session: {
      sessionId: context.sessionId ?? null,
      keyId: context.keyId ?? null,
      secured: false,
      transportMode: context.transportMode,
      fallback: !!context.fallback,
    },
  };
}

export { EnforcementMode };

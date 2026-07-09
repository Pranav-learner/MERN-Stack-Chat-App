/**
 * @module integration/socketIdentity
 *
 * Layer 3 · Sprint 4 — makes Socket.IO connections **identity-aware**. It attaches
 * the connecting user's identity / device / verification / trust context to
 * `socket.data.identity` so downstream handlers (and future Layer 4 handshakes)
 * know who and what they are talking to.
 *
 * It does NOT encrypt sockets and does NOT change the existing presence / room /
 * message delivery behaviour. It is purely additive and backward compatible:
 *
 * - If a JWT is supplied in the handshake (`auth.token` or `query.token`), it is
 *   verified and the AUTHENTICATED user id is used (an improvement over the legacy
 *   spoofable `query.userId`).
 * - Otherwise it falls back to the existing `query.userId` (unauthenticated), so
 *   older clients keep working.
 *
 * @security Attaching identity does not by itself authorize anything. When a
 * verified JWT is present, `authenticated: true` signals the id is trustworthy.
 */

/**
 * Resolve and attach identity context to a socket.
 *
 * @param {import("socket.io").Socket} socket
 * @param {{ service: object, verifyToken?: (token: string) => (object|null) }} deps
 * @returns {Promise<object|null>} the attached identity summary, or null if no user
 * @example
 * ```js
 * io.on("connection", async (socket) => {
 *   const ctx = await attachSocketIdentity(socket, { service, verifyToken });
 *   if (ctx) socket.emit("identityContext", ctx);
 * });
 * ```
 */
export async function attachSocketIdentity(socket, { service, verifyToken }) {
  const handshake = socket.handshake ?? {};
  const auth = handshake.auth ?? {};
  const query = handshake.query ?? {};

  const token = auth.token ?? query.token;
  const deviceId = auth.deviceId ?? query.deviceId ?? null;

  let userId = query.userId ?? null;
  let authenticated = false;

  if (token && typeof verifyToken === "function") {
    const decoded = verifyToken(token);
    if (decoded && decoded.id) {
      userId = decoded.id; // authenticated id takes precedence over query.userId
      authenticated = true;
    }
  }

  if (!userId) return null;

  const context = await service.loadContext(userId, deviceId ? { deviceId } : {});
  const summary = {
    userId: String(userId),
    authenticated,
    deviceId,
    provisioned: context.provisioned,
    identityId: context.identity?.identityId ?? null,
    fingerprint: context.identity?.fingerprint?.machine ?? null,
    deviceTrust: context.currentDevice?.effectiveTrustStatus ?? null,
    sessionValid: context.sessionValid,
    ready: context.ready,
    verification: context.verification,
    warnings: context.warnings,
  };

  socket.data = socket.data ?? {};
  socket.data.identity = summary;
  return summary;
}

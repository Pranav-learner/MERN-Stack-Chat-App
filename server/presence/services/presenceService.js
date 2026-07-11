/**
 * @module presence/services
 *
 * Higher-level **Presence Service** helpers that compose the {@link module:presence/manager
 * PresenceManager} for the concrete lifecycles a transport drives — most notably a WebSocket
 * connection's connect → heartbeat → disconnect arc. Keeping this here (rather than in the
 * socket handler) means every transport binding shares one presence lifecycle, and it stays
 * unit-testable without a real socket.
 *
 * @security Operates on PUBLIC presence metadata only. Device advertisements carry public
 * identity keys + fingerprints — never private keys or session secrets.
 *
 * @evolution This is the seam a future Capability Exchange sprint extends: `onConnect` is where
 * a device would additionally advertise *how* it can be reached once that is implemented. Today
 * it only records *that* the device is reachable.
 */

import { PresenceStatus } from "../types/types.js";

/**
 * Build a presence service over a manager.
 * @param {object} deps
 * @param {import("../manager/presenceManager.js").PresenceManager} deps.manager
 * @returns {object} the presence service
 */
export function createPresenceService(deps) {
  if (!deps || !deps.manager) throw new Error("createPresenceService requires { manager }");
  const manager = deps.manager;

  return {
    /**
     * A device connected (e.g. a socket opened): register/revive its presence + advertise it.
     * Idempotent for reconnects — a still-reachable record is refreshed via heartbeat instead of
     * a duplicate registration.
     * @param {{ userId: string, deviceId: string, identityId?: string, identity?: object,
     *   status?: string, softwareVersion?: string, platform?: string, timeoutMs?: number, metadata?: object }} input
     * @returns {Promise<object>} public presence DTO
     */
    async onConnect(input) {
      const existing = await manager.presence.findByUserAndDevice(input.userId, input.deviceId);
      if (existing && ["online", "away", "busy", "invisible"].includes(existing.status)) {
        // Already reachable → treat the (re)connect as a heartbeat so we never throw a duplicate.
        return manager.heartbeat(existing.presenceId, { timeoutMs: input.timeoutMs });
      }
      return manager.registerPresence({ status: PresenceStatus.ONLINE, ...input });
    },

    /**
     * A device sent a heartbeat over the connection.
     * @param {{ userId: string, deviceId: string, timeoutMs?: number }} input @returns {Promise<object|null>}
     */
    async onHeartbeat(input) {
      const record = await manager.presence.findByUserAndDevice(input.userId, input.deviceId);
      if (!record) return null;
      return manager.heartbeat(record.presenceId, { timeoutMs: input.timeoutMs });
    },

    /**
     * A device's connection dropped (e.g. a socket closed): mark it disconnected so the sweep
     * can later expire it if it never comes back.
     * @param {{ userId: string, deviceId: string, reason?: string }} input @returns {Promise<object|null>}
     */
    async onDisconnect(input) {
      return manager.markDeviceDisconnected(input.userId, input.deviceId, { reason: input.reason ?? "socket-closed" });
    },

    /**
     * A snapshot of which of a user's devices are reachable + which appear online.
     * @param {string} userId @returns {Promise<{ userId: string, reachable: object[], online: object[] }>}
     */
    async summaryFor(userId) {
      const [{ devices }, online] = await Promise.all([
        manager.lookupUserPresence(userId),
        manager.listOnline(userId),
      ]);
      return { userId: String(userId), reachable: devices, online };
    },

    /** The underlying manager (escape hatch). */
    manager,
  };
}

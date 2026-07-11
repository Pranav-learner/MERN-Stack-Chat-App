/**
 * @module presence/api
 *
 * The **transport-independent Presence API facade**. It wraps a
 * {@link module:presence/manager PresenceManager} in a small, stable, use-case-oriented surface
 * — register, update, heartbeat, lookup, list online, last-seen, history — that ANY transport
 * binds to. The Express controller is one such binding; the WebSocket layer is another; a future
 * WebRTC-signaling / QUIC transport reuses this same facade instead of re-implementing presence.
 *
 * @security The facade exposes PUBLIC DTOs only (from the serializers). It never returns a
 * private key, session key, message key, chain key, or shared secret. Every mutating operation
 * takes an explicit `actingUser` so a binding can enforce ownership uniformly.
 *
 * @example
 * ```js
 * const api = createPresenceApi(presenceManager);
 * const p = await api.register({ actingUser: "u1", deviceId: "d1", status: "online" });
 * await api.heartbeat({ actingUser: "u1", presenceId: p.presenceId });
 * const online = await api.listOnline({ actingUser: "u1", userId: "u2" });
 * ```
 */

import { PresenceValidationError } from "../errors.js";

/**
 * @param {import("../manager/presenceManager.js").PresenceManager} manager
 * @returns {object} the Presence API facade
 */
export function createPresenceApi(manager) {
  if (!manager) throw new Error("createPresenceApi requires a PresenceManager");

  const requireActor = (actingUser) => {
    if (!actingUser) throw new PresenceValidationError("actingUser is required");
    return String(actingUser);
  };

  return {
    /**
     * Register (or revive) the caller's device presence.
     * @param {{ actingUser: string, deviceId: string, identityId?: string, identity?: object,
     *   status?: string, softwareVersion?: string, platform?: string, timeoutMs?: number, metadata?: object }} input
     * @returns {Promise<object>} public presence DTO
     */
    async register(input) {
      const userId = requireActor(input.actingUser);
      return manager.registerPresence({ ...input, userId });
    },

    /**
     * Update the caller's device status (online / away / busy / invisible).
     * @param {{ actingUser: string, presenceId: string, status: string, metadata?: object, softwareVersion?: string, platform?: string }} input
     * @returns {Promise<object>}
     */
    async update(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.updatePresence(input.presenceId, { ...input, actingUser });
    },

    /**
     * Heartbeat the caller's device (refresh liveness; recover if it had dropped).
     * @param {{ actingUser: string, presenceId: string, timeoutMs?: number }} input @returns {Promise<object>}
     */
    async heartbeat(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.heartbeat(input.presenceId, { actingUser, timeoutMs: input.timeoutMs });
    },

    /**
     * Mark the caller's device cleanly offline.
     * @param {{ actingUser: string, presenceId: string, reason?: string }} input @returns {Promise<object>}
     */
    async goOffline(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.markOffline(input.presenceId, { actingUser, reason: input.reason });
    },

    /**
     * Remove the caller's device presence record.
     * @param {{ actingUser: string, presenceId: string }} input @returns {Promise<{ presenceId: string, removed: boolean }>}
     */
    async remove(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.removePresence(input.presenceId, { actingUser });
    },

    /**
     * A device's presence (owner-scoped when it's the caller's own).
     * @param {{ actingUser: string, presenceId: string, includeHistory?: boolean }} input @returns {Promise<object>}
     */
    async getPresence(input) {
      requireActor(input.actingUser);
      return manager.getPresence(input.presenceId, { includeHistory: input.includeHistory });
    },

    /**
     * Resolve which of a user's devices are currently reachable (device advertisements).
     * @param {{ actingUser: string, userId: string }} input
     * @returns {Promise<{ userId: string, devices: object[], source: string }>}
     */
    async lookup(input) {
      requireActor(input.actingUser);
      return manager.lookupUserPresence(input.userId);
    },

    /**
     * List a user's VISIBLE-online devices (excludes invisible).
     * @param {{ actingUser: string, userId: string }} input @returns {Promise<object[]>}
     */
    async listOnline(input) {
      requireActor(input.actingUser);
      return manager.listOnline(input.userId);
    },

    /**
     * A device's last-seen view.
     * @param {{ actingUser: string, userId: string, deviceId: string }} input @returns {Promise<object>}
     */
    async lastSeen(input) {
      requireActor(input.actingUser);
      return manager.getLastSeen(input.userId, input.deviceId);
    },

    /**
     * A device's status history (owner-scoped when it's the caller's own).
     * @param {{ actingUser: string, presenceId: string }} input @returns {Promise<object[]>}
     */
    async history(input) {
      requireActor(input.actingUser);
      return manager.getHistory(input.presenceId);
    },

    /** The underlying manager (escape hatch for advanced bindings). */
    manager,
  };
}

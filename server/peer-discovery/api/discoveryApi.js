/**
 * @module peer-discovery/api
 *
 * The **transport-independent Discovery API facade**. It wraps a
 * {@link module:peer-discovery/manager DiscoveryManager} in a small, stable, use-case
 * oriented surface — create session, lookup user, lookup devices, status, cancel, list
 * active — that ANY transport binds to. The Express controller is one such binding; a
 * future WebSocket, WebRTC-signaling, QUIC, or P2P transport reuses this same facade
 * instead of re-implementing discovery.
 *
 * @security The facade exposes PUBLIC DTOs only (from the serializers). It never returns
 * a private key, session key, message key, chain key, or shared secret. Every operation
 * takes an explicit `actingUser` so a binding can enforce authorization uniformly.
 *
 * @example
 * ```js
 * const api = createDiscoveryApi(discoveryManager);
 * const { session } = await api.lookupUser({ actingUser: "u1", targetUser: "u2" });
 * const status = await api.getStatus({ actingUser: "u1", discoveryId: session.discoveryId });
 * ```
 */

import { DiscoveryValidationError } from "../errors.js";

/**
 * @param {import("../manager/discoveryManager.js").DiscoveryManager} manager
 * @returns {object} the Discovery API facade
 */
export function createDiscoveryApi(manager) {
  if (!manager) throw new Error("createDiscoveryApi requires a DiscoveryManager");

  const requireActor = (actingUser) => {
    if (!actingUser) throw new DiscoveryValidationError("actingUser is required");
    return String(actingUser);
  };

  return {
    /**
     * Create (stage) a discovery session without resolving it.
     * @param {{ actingUser: string, targetUser: string, requesterDevice?: string, targetDevices?: string[], ttlMs?: number, metadata?: object }} input
     * @returns {Promise<{ session: object }>}
     */
    async createSession(input) {
      const requester = requireActor(input.actingUser);
      const session = await manager.createDiscoverySession({ ...input, requester });
      return { session };
    },

    /**
     * Look up a user → identity + all discoverable devices.
     * @param {{ actingUser: string, targetUser: string, requesterDevice?: string, ttlMs?: number, metadata?: object }} input
     * @returns {Promise<{ session: object, metadata: object|null }>}
     */
    async lookupUser(input) {
      const requester = requireActor(input.actingUser);
      return manager.lookupUser({ ...input, requester });
    },

    /**
     * Look up a single device of a user.
     * @param {{ actingUser: string, targetUser: string, deviceId: string, requesterDevice?: string, ttlMs?: number }} input
     * @returns {Promise<{ session: object, metadata: object|null }>}
     */
    async lookupDevice(input) {
      const requester = requireActor(input.actingUser);
      return manager.lookupDevice({ ...input, requester });
    },

    /**
     * Look up a subset (or all) of a user's devices.
     * @param {{ actingUser: string, targetUser: string, deviceIds?: string[], requesterDevice?: string, ttlMs?: number }} input
     * @returns {Promise<{ session: object, metadata: object|null }>}
     */
    async lookupDevices(input) {
      const requester = requireActor(input.actingUser);
      return manager.lookupDevices({ ...input, requester });
    },

    /**
     * Full session view (authorized to the requester).
     * @param {{ actingUser: string, discoveryId: string, includeAudit?: boolean }} input
     * @returns {Promise<object>}
     */
    async getDiscovery(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getDiscovery(input.discoveryId, { actingUser, includeAudit: input.includeAudit });
    },

    /**
     * Compact status view (for polling).
     * @param {{ actingUser: string, discoveryId: string }} input @returns {Promise<object>}
     */
    async getStatus(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getDiscoveryStatus(input.discoveryId, { actingUser });
    },

    /**
     * Cancel an active discovery.
     * @param {{ actingUser: string, discoveryId: string, reason?: string }} input @returns {Promise<object>}
     */
    async cancel(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.cancelDiscovery(input.discoveryId, { actingUser, reason: input.reason });
    },

    /**
     * Mark a resolved discovery completed (result consumed).
     * @param {{ actingUser: string, discoveryId: string }} input @returns {Promise<object>}
     */
    async complete(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.completeDiscovery(input.discoveryId, { actingUser });
    },

    /**
     * List the caller's active discoveries.
     * @param {{ actingUser: string }} input @returns {Promise<object[]>}
     */
    async listActive(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.listActiveDiscoveries(actingUser);
    },

    /**
     * List all the caller's discoveries.
     * @param {{ actingUser: string, activeOnly?: boolean }} input @returns {Promise<object[]>}
     */
    async list(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.listDiscoveries(actingUser, { activeOnly: input.activeOnly });
    },

    /** The underlying manager (escape hatch for advanced bindings). */
    manager,
  };
}

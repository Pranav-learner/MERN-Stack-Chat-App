/**
 * @module pdp/api
 *
 * The **transport-independent Peer Discovery Protocol API facade**. It wraps a
 * {@link module:pdp/manager PeerDiscoveryManager} in a small, stable, use-case-oriented surface —
 * start discovery, get connection plan, resolve devices/preferred device, status, history — that
 * ANY transport binds to. The Express controller is one such binding; a future Layer 7 orchestrator
 * reuses this same facade instead of re-implementing discovery.
 *
 * @security The facade exposes PUBLIC DTOs only (from the serializers). It never returns a private
 * key, session key, message key, chain key, or shared secret. Every operation takes an explicit
 * `actingUser` so a binding can enforce authorization uniformly.
 *
 * @example
 * ```js
 * const api = createPdpApi(peerDiscoveryManager);
 * const { session, plan } = await api.startDiscovery({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2" });
 * const status = await api.getStatus({ actingUser: "u1", discoveryId: session.discoveryId });
 * ```
 */

import { PdpValidationError } from "../errors.js";

/**
 * @param {import("../manager/peerDiscoveryManager.js").PeerDiscoveryManager} manager
 * @returns {object} the PDP API facade
 */
export function createPdpApi(manager) {
  if (!manager) throw new Error("createPdpApi requires a PeerDiscoveryManager");

  const requireActor = (actingUser) => {
    if (!actingUser) throw new PdpValidationError("actingUser is required");
    return String(actingUser);
  };

  return {
    /**
     * Start a discovery run → returns the session + the produced connection plan.
     * @param {{ actingUser: string, requesterDevice: string, targetUser: string, targetDevices?: string[],
     *   selectionPolicy?: string, transportPolicy?: string, selectionOptions?: object, maxDevices?: number,
     *   ttlMs?: number, useCache?: boolean }} input
     * @returns {Promise<{ session: object, plan: object|null, source: string }>}
     */
    async startDiscovery(input) {
      const requester = requireActor(input.actingUser);
      return manager.startDiscovery({ ...input, requester }, { useCache: input.useCache });
    },

    /**
     * The connection plan produced by a discovery run.
     * @param {{ actingUser: string, discoveryId: string }} input @returns {Promise<{ plan: object, expired: boolean }>}
     */
    async getConnectionPlan(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getConnectionPlan(input.discoveryId, { actingUser });
    },

    /**
     * A connection plan by its planId.
     * @param {{ actingUser: string, planId: string }} input @returns {Promise<{ plan: object, expired: boolean }>}
     */
    async getPlan(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getPlanById(input.planId, { actingUser });
    },

    /**
     * Resolve which of a target user's devices are discoverable + reachable (no session).
     * @param {{ actingUser: string, requesterDevice?: string, targetUser: string }} input
     * @returns {Promise<{ targetUser: string, devices: object[] }>}
     */
    async resolveDevices(input) {
      const requester = requireActor(input.actingUser);
      return manager.resolveDevices({ ...input, requester });
    },

    /**
     * Resolve the single preferred device + transport for a target user.
     * @param {{ actingUser: string, requesterDevice: string, targetUser: string, selectionPolicy?: string, transportPolicy?: string }} input
     * @returns {Promise<object|null>}
     */
    async resolvePreferredDevice(input) {
      const requester = requireActor(input.actingUser);
      return manager.resolvePreferredDevice({ ...input, requester });
    },

    /**
     * Full discovery-session view (authorized to the requester).
     * @param {{ actingUser: string, discoveryId: string, includeAudit?: boolean }} input @returns {Promise<object>}
     */
    async getDiscovery(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getDiscovery(input.discoveryId, { actingUser, includeAudit: input.includeAudit });
    },

    /**
     * Compact discovery status (for polling).
     * @param {{ actingUser: string, discoveryId: string }} input @returns {Promise<object>}
     */
    async getStatus(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getDiscoveryStatus(input.discoveryId, { actingUser });
    },

    /**
     * Recover (retry) a recoverable failed discovery.
     * @param {{ actingUser: string, discoveryId: string }} input @returns {Promise<{ session: object, plan: object|null, source: string }>}
     */
    async recover(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.recoverDiscovery(input.discoveryId, { actingUser });
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
     * A requester's discovery history.
     * @param {{ actingUser: string, activeOnly?: boolean, limit?: number }} input @returns {Promise<object[]>}
     */
    async history(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.listDiscoveries(actingUser, { activeOnly: input.activeOnly, limit: input.limit });
    },

    /** The underlying manager (escape hatch for advanced bindings). */
    manager,
  };
}

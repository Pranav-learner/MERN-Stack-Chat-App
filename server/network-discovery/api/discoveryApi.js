/**
 * @module network-discovery/api
 *
 * The **transport-independent Network Discovery API facade**. A small, stable, use-case-oriented
 * surface over the {@link module:network-discovery/manager NetworkDiscoveryManager} — generate /
 * refresh a profile, get candidates, list interfaces, get public address / NAT info, diagnostics —
 * that ANY transport binds to. The Express controller is one binding; a future ICE orchestrator is
 * another.
 *
 * @security The facade exposes PUBLIC DTOs only. It never returns a private key, session key, message
 * key, chain key, or shared secret. Every operation takes an explicit `actingUser` so a binding can
 * enforce authorization uniformly; discovery is inherently for the caller's OWN device.
 *
 * @example
 * ```js
 * const api = createDiscoveryApi(manager);
 * const profile = await api.generate({ actingUser: "u1", deviceId: "d1", candidates });
 * const nat = await api.getNatInfo({ actingUser: "u1", deviceId: "d1" });
 * ```
 */

import { DiscoveryValidationError } from "../errors.js";

/**
 * @param {import("../manager/networkDiscoveryManager.js").NetworkDiscoveryManager} manager
 * @returns {object} the Network Discovery API facade
 */
export function createDiscoveryApi(manager) {
  if (!manager) throw new Error("createDiscoveryApi requires a NetworkDiscoveryManager");

  const requireActor = (actingUser) => {
    if (!actingUser) throw new DiscoveryValidationError("actingUser is required");
    return String(actingUser);
  };

  return {
    /**
     * Generate the caller's device network profile (device-reported interfaces/STUN/candidates or
     * server-run discovery).
     * @param {{ actingUser: string, deviceId: string, interfaces?: object[], stunResults?: object[], candidates?: object[], stunServers?: object[], ttlMs?: number }} input
     * @returns {Promise<object>}
     */
    async generate(input) {
      const userId = requireActor(input.actingUser);
      return manager.generateProfile({ ...input, userId });
    },

    /**
     * Refresh the caller's device network profile.
     * @param {{ actingUser: string, deviceId: string, interfaces?: object[], stunResults?: object[], candidates?: object[] }} input
     * @returns {Promise<object>}
     */
    async refresh(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.refreshProfile(input.deviceId, { ...input, actingUser, userId: actingUser });
    },

    /**
     * A network profile by id (owner-scoped).
     * @param {{ actingUser: string, profileId: string, includeCandidates?: boolean }} input @returns {Promise<object>}
     */
    async getProfile(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getProfile(input.profileId, { actingUser, includeCandidates: input.includeCandidates });
    },

    /**
     * The caller's current profile for a device.
     * @param {{ actingUser: string, deviceId: string }} input @returns {Promise<object>}
     */
    async getCurrent(input) {
      requireActor(input.actingUser);
      return manager.getCurrentProfile(input.deviceId);
    },

    /**
     * The device's non-expired candidates.
     * @param {{ actingUser: string, deviceId: string }} input @returns {Promise<object[]>}
     */
    async getCandidates(input) {
      requireActor(input.actingUser);
      return manager.getCandidates(input.deviceId);
    },

    /**
     * The device's interfaces.
     * @param {{ actingUser: string, deviceId?: string }} input @returns {Promise<object[]>}
     */
    async listInterfaces(input) {
      requireActor(input.actingUser);
      return manager.listInterfaces(input.deviceId);
    },

    /**
     * The device's public-address view.
     * @param {{ actingUser: string, deviceId: string }} input @returns {Promise<object>}
     */
    async getPublicAddress(input) {
      requireActor(input.actingUser);
      return manager.getPublicAddress(input.deviceId);
    },

    /**
     * The device's NAT-info view.
     * @param {{ actingUser: string, deviceId: string }} input @returns {Promise<object>}
     */
    async getNatInfo(input) {
      requireActor(input.actingUser);
      return manager.getNatInfo(input.deviceId);
    },

    /**
     * The device's discovery diagnostics (+ history).
     * @param {{ actingUser: string, deviceId: string, limit?: number }} input @returns {Promise<object>}
     */
    async getDiagnostics(input) {
      requireActor(input.actingUser);
      return manager.getDiagnostics(input.deviceId, { limit: input.limit });
    },

    /** The underlying manager (escape hatch). */
    manager,
  };
}

/**
 * @module capabilities/api
 *
 * The **transport-independent Capability API facade**. It wraps a
 * {@link module:capabilities/manager CapabilityManager} in a small, stable, use-case-oriented
 * surface — register, update, negotiate, resolve preferred transport, status, history — that ANY
 * transport binds to. The Express controller is one such binding; a future WebRTC-signaling / QUIC
 * transport reuses this same facade instead of re-implementing capability exchange.
 *
 * @security The facade exposes PUBLIC DTOs only (from the serializers). It never returns a private
 * key, session key, message key, chain key, or shared secret. Every mutating operation takes an
 * explicit `actingUser` so a binding can enforce ownership uniformly.
 *
 * @example
 * ```js
 * const api = createCapabilityApi(capabilityManager);
 * const caps = await api.register({ actingUser: "u1", deviceId: "d1", transports: ["websocket","relay"] });
 * const { result } = await api.negotiate({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
 * result.preferredTransport;
 * ```
 */

import { CapabilityValidationError } from "../errors.js";

/**
 * @param {import("../manager/capabilityManager.js").CapabilityManager} manager
 * @returns {object} the Capability API facade
 */
export function createCapabilityApi(manager) {
  if (!manager) throw new Error("createCapabilityApi requires a CapabilityManager");

  const requireActor = (actingUser) => {
    if (!actingUser) throw new CapabilityValidationError("actingUser is required");
    return String(actingUser);
  };

  return {
    /**
     * Register the caller's device capabilities.
     * @param {{ actingUser: string, deviceId: string, ...capabilityFields }} input @returns {Promise<object>}
     */
    async register(input) {
      const userId = requireActor(input.actingUser);
      return manager.registerCapabilities({ ...input, userId });
    },

    /**
     * Update the caller's device capabilities (bumps the version).
     * @param {{ actingUser: string, capabilityId: string, ...capabilityFields }} input @returns {Promise<object>}
     */
    async update(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.updateCapabilities(input.capabilityId, { ...input, actingUser });
    },

    /**
     * Refresh the caller's capability TTL (liveness). @param {{ actingUser: string, capabilityId: string, ttlMs?: number }} input
     * @returns {Promise<object>}
     */
    async refresh(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.refreshCapabilities(input.capabilityId, { actingUser, ttlMs: input.ttlMs });
    },

    /**
     * Remove the caller's capability set. @param {{ actingUser: string, capabilityId: string }} input
     * @returns {Promise<{ capabilityId: string, removed: boolean }>}
     */
    async remove(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.removeCapabilities(input.capabilityId, { actingUser });
    },

    /**
     * A device's capability set (public DTO). @param {{ actingUser: string, capabilityId: string, includeHistory?: boolean }} input
     * @returns {Promise<object>}
     */
    async getCapabilities(input) {
      requireActor(input.actingUser);
      return manager.getCapabilities(input.capabilityId, { includeHistory: input.includeHistory });
    },

    /**
     * A device's capabilities by (userId, deviceId). @param {{ actingUser: string, userId: string, deviceId: string }} input
     * @returns {Promise<object>}
     */
    async getDeviceCapabilities(input) {
      requireActor(input.actingUser);
      return manager.getDeviceCapabilities(input.userId, input.deviceId);
    },

    /**
     * Negotiate how the caller's device + a peer's device can communicate.
     * @param {{ actingUser: string, requesterDevice: string, targetUser: string, targetDevice: string, policy?: string|object }} input
     * @returns {Promise<{ result: object, source: string, negotiationId: string|null }>}
     */
    async negotiate(input) {
      const requester = requireActor(input.actingUser);
      return manager.negotiate({ ...input, requester });
    },

    /**
     * Resolve just the preferred transport (+ fallback chain) for the caller's device + a peer's.
     * @param {{ actingUser: string, requesterDevice: string, targetUser: string, targetDevice: string, policy?: string|object }} input
     * @returns {Promise<object>}
     */
    async resolvePreferredTransport(input) {
      const requester = requireActor(input.actingUser);
      return manager.resolvePreferredTransport({ ...input, requester });
    },

    /**
     * Negotiation history for the caller's device.
     * @param {{ actingUser: string, deviceId: string, limit?: number }} input @returns {Promise<object[]>}
     */
    async history(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getNegotiationHistory(actingUser, input.deviceId, { limit: input.limit });
    },

    /** The underlying manager (escape hatch for advanced bindings). */
    manager,
  };
}

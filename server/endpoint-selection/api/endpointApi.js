/**
 * @module endpoint-selection/api
 *
 * The **transport-independent Endpoint Selection API facade**. It wraps an
 * {@link module:endpoint-selection/manager EndpointSelectionManager} in a small, stable, use-case-
 * oriented surface — generate plan, select endpoint, rank devices, get fallbacks, routing history,
 * selection details, endpoint status — that ANY transport binds to. The Express controller is one
 * such binding; a future Layer 7 orchestrator reuses this same facade.
 *
 * @security The facade exposes PUBLIC DTOs only (from the serializers). It never returns a private
 * key, session key, message key, chain key, or shared secret. Every operation takes an explicit
 * `actingUser` so a binding can enforce authorization uniformly.
 *
 * @example
 * ```js
 * const api = createEndpointApi(manager);
 * const { plan } = await api.generatePlan({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2", candidates });
 * const fallbacks = await api.getFallbacks({ actingUser: "u1", planId: plan.planId });
 * ```
 */

import { EndpointValidationError } from "../errors.js";

/**
 * @param {import("../manager/endpointSelectionManager.js").EndpointSelectionManager} manager
 * @returns {object} the Endpoint Selection API facade
 */
export function createEndpointApi(manager) {
  if (!manager) throw new Error("createEndpointApi requires an EndpointSelectionManager");

  const requireActor = (actingUser) => {
    if (!actingUser) throw new EndpointValidationError("actingUser is required");
    return String(actingUser);
  };

  return {
    /**
     * Generate an optimized connection plan for a target user's candidate devices.
     * @param {{ actingUser: string, requesterDevice: string, targetUser: string, candidates: object[],
     *   policy?: string|object, preferredPlatform?: string, preferredDeviceId?: string, securityRequirements?: object,
     *   maxFallbacks?: number, retry?: object, useCache?: boolean }} input
     * @returns {Promise<{ plan: object, ranking: object[], source: string }>}
     */
    async generatePlan(input) {
      const requester = requireActor(input.actingUser);
      return manager.generateConnectionPlan({ ...input, requester }, { useCache: input.useCache });
    },

    /**
     * Select just the primary endpoint for a target user.
     * @param {{ actingUser: string, requesterDevice: string, targetUser: string, candidates: object[], policy?: string|object }} input
     * @returns {Promise<object|null>}
     */
    async selectEndpoint(input) {
      const requester = requireActor(input.actingUser);
      return manager.selectEndpoint({ ...input, requester }, { useCache: input.useCache });
    },

    /**
     * Rank a target user's candidate devices (no plan produced).
     * @param {{ actingUser: string, targetUser: string, candidates: object[], policy?: string|object }} input
     * @returns {Promise<{ ranking: object[], policy: string }>}
     */
    async rankDevices(input) {
      const requester = requireActor(input.actingUser);
      return manager.rankDevices({ ...input, requester });
    },

    /**
     * The fallback endpoints of a plan.
     * @param {{ actingUser: string, planId: string }} input @returns {Promise<object[]>}
     */
    async getFallbacks(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getFallbacks(input.planId, { actingUser });
    },

    /**
     * A connection plan by id.
     * @param {{ actingUser: string, planId: string }} input @returns {Promise<{ plan: object, expired: boolean }>}
     */
    async getPlan(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getConnectionPlan(input.planId, { actingUser });
    },

    /**
     * Compact plan status (endpoint status).
     * @param {{ actingUser: string, planId: string }} input @returns {Promise<object>}
     */
    async getStatus(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.getPlanStatus(input.planId, { actingUser });
    },

    /**
     * Fail over to the next fallback endpoint.
     * @param {{ actingUser: string, planId: string, reason?: string }} input @returns {Promise<object>}
     */
    async failover(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.failover(input.planId, { actingUser, reason: input.reason });
    },

    /**
     * Refresh a plan's routing from fresh candidates.
     * @param {{ actingUser: string, planId: string, candidates: object[] }} input @returns {Promise<object>}
     */
    async refreshPlan(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.refreshPlan(input.planId, { actingUser, candidates: input.candidates });
    },

    /**
     * Update routing to try a specific device first.
     * @param {{ actingUser: string, planId: string, deviceId: string }} input @returns {Promise<object>}
     */
    async updateRouting(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.updateRouting(input.planId, input.deviceId, { actingUser });
    },

    /**
     * Record the outcome of using an endpoint (feeds historical reliability).
     * @param {{ actingUser: string, planId: string, deviceId: string, outcome: string }} input @returns {Promise<object>}
     */
    async recordOutcome(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.recordOutcome(input.planId, input.deviceId, input.outcome, { actingUser });
    },

    /**
     * Routing / selection history for the caller.
     * @param {{ actingUser: string, targetUser?: string, limit?: number }} input @returns {Promise<object[]>}
     */
    async history(input) {
      const actingUser = requireActor(input.actingUser);
      return manager.listSelections(actingUser, { targetUser: input.targetUser, limit: input.limit });
    },

    /** The underlying manager (escape hatch). */
    manager,
  };
}

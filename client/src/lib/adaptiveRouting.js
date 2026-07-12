/**
 * Client Intelligent Routing integration (Layer 12, Sprint 2).
 *
 * Drives the `/api/adaptive-routing` subsystem: hand it a communication request (plus optional capability
 * + network hints) and it returns the INTELLIGENT decision — the negotiated capability profile, the
 * communication + network analysis, the ranked route scores, the selected strategy, a deterministic
 * fallback plan, the execution plan, and a human-readable EXPLANATION of why that route won. A debug /
 * observability panel can render the ranking + explanation so a user (or engineer) sees *why* a message
 * went direct vs relayed vs offline.
 *
 * The application still SENDS through the Communication Fabric (`/api/communication-fabric`, Layer 12
 * Sprint 1) — which this sprint makes adaptive automatically. Use this client to preview / explain / audit
 * a routing decision, or to drive an adaptive UI.
 *
 * @security This lib exchanges communication CONTROL-PLANE metadata + declared capability + network
 * AVAILABILITY hints only — never message content or keys. The encrypted bytes travel through the
 * underlying subsystem libs.
 *
 * @example
 * ```js
 * import { AdaptiveRoutingClient } from "../lib/adaptiveRouting.js";
 * const routing = new AdaptiveRoutingClient({ axios });
 * const best = await routing.getBestRoute({ type: "direct-message", recipients: [bobId], network: { p2p: false } });
 * // best.selection.strategy === "relay"  (p2p down → adaptive relay)
 * const full = await routing.evaluate({ type: "media-transfer", recipients: [bobId], mediaType: "video", payloadRef: { id, size } });
 * // full.explanation.summary explains the choice
 * ```
 */

const BASE = "/api/adaptive-routing";

/** Strategy constants (mirror the server `StrategyType`). */
export const STRATEGY = Object.freeze({ DIRECT: "direct", RELAY: "relay", OFFLINE: "offline", MEDIA: "media", GROUP: "group", SYNCHRONIZATION: "synchronization", HYBRID: "hybrid" });

/** Route constants (mirror the server `RouteKind`). */
export const ROUTE = Object.freeze({ DIRECT: "direct-transport", RELAY: "relayed-transport", STORE_AND_FORWARD: "store-and-forward", MEDIA_PIPELINE: "media-pipeline", GROUP_FANOUT: "group-fanout", SYNC_CHANNEL: "sync-channel" });

export class AdaptiveRoutingClient {
  /** @param {object} deps @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance */
  constructor(deps) {
    if (!deps?.axios) throw new Error("AdaptiveRoutingClient requires { axios }");
    this.axios = deps.axios;
  }

  /**
   * Full intelligent evaluation of a communication request. `senderId` is taken from the caller server-side.
   * @param {object} request a communication request + optional `{ capabilities, receiverCapabilities, network, policyOverrides, weights }`
   * @returns {Promise<object>} `{ capability, analysis, network, ranking, selection, fallbackPlan, executionPlan, explanation }`
   */
  async evaluate(request) {
    const { data } = await this.axios.post(`${BASE}/evaluate`, request);
    return data.result;
  }

  /** The best route only (dry run) → `{ selection, ranking }`. */
  async getBestRoute(request) {
    const { data } = await this.axios.post(`${BASE}/best-route`, request);
    return data.bestRoute;
  }

  /** The negotiated capability profile for a communication. */
  async getCapabilityProfile({ recipients = [], capabilities, receiverCapabilities } = {}) {
    const { data } = await this.axios.post(`${BASE}/capability-profile`, { recipients, capabilities, receiverCapabilities });
    return data.profile;
  }

  /** The ranked route scores (dry run) — for a routing-explainer panel. */
  async getRouteScores(request) {
    const { data } = await this.axios.post(`${BASE}/route-scores`, request);
    return data.scores;
  }

  /** The decision explanation (dry run) — why the winning route won + why others lost. */
  async explain(request) {
    const { data } = await this.axios.post(`${BASE}/explain`, request);
    return data.explanation;
  }

  /** The deterministic fallback plan (dry run). */
  async getFallbackPlan(request) {
    const { data } = await this.axios.post(`${BASE}/fallback-plan`, request);
    return data.fallbackPlan;
  }

  /** Evaluation diagnostics + audit trail for a request. */
  async getDiagnostics(requestId) {
    const { data } = await this.axios.get(`${BASE}/diagnostics/${encodeURIComponent(requestId)}`);
    return data.diagnostics;
  }

  /** Adaptive health (strategies · weights · hooks · caches · metrics). */
  async health() {
    const { data } = await this.axios.get(`${BASE}/health`);
    return data.health;
  }
}

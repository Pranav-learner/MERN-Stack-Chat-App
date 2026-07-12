/**
 * Client Distributed Communication Fabric integration (Layer 12, Sprint 1).
 *
 * This is the client's single entry point for ALL communication. Instead of the app calling the messaging,
 * media, group, or synchronization libs directly, it hands a communication REQUEST to the Fabric, which
 * decides the strategy + route, plans the execution, and delegates to the right subsystem. The app asks
 * "communicate this" and the Fabric answers "here's how it was done" — the orchestration lives server-side.
 *
 * The lib also exposes the inspection endpoints (build context, evaluate policies, get strategy, get
 * execution plan, diagnostics) so a UI can show WHY a communication took a given path — useful for debug
 * panels and, later, the Sprint-2 adaptive-routing visualizer.
 *
 * @security This lib exchanges communication CONTROL-PLANE metadata ONLY with the Fabric — request kind,
 * recipients, conversation/media/priority descriptors, and an OPAQUE payload reference. The encrypted
 * bytes still move through the underlying subsystem libs (messaging/media); the Fabric never sees content
 * or keys.
 *
 * @example
 * ```js
 * import { CommunicationFabricClient, COMM_TYPE } from "../lib/communicationFabric.js";
 * const fabric = new CommunicationFabricClient({ axios });
 * const { decision, status } = await fabric.execute({ type: COMM_TYPE.DIRECT_MESSAGE, recipients: [bobId], payloadRef: { id: msgId } });
 * // decision.strategy === "direct"; status === "completed"
 * ```
 */

const BASE = "/api/communication-fabric";

/** Communication type constants (mirror the server `CommunicationType`). */
export const COMM_TYPE = Object.freeze({
  DIRECT_MESSAGE: "direct-message",
  GROUP_MESSAGE: "group-message",
  MEDIA_TRANSFER: "media-transfer",
  SYNCHRONIZATION: "synchronization",
  PRESENCE: "presence",
  RECEIPT: "receipt",
  CONTROL: "control",
});

/** Priority constants (mirror the server `Priority`). */
export const PRIORITY = Object.freeze({ LOW: "low", NORMAL: "normal", HIGH: "high", URGENT: "urgent" });

/** Strategy constants (mirror the server `StrategyType`). */
export const STRATEGY = Object.freeze({ DIRECT: "direct", RELAY: "relay", OFFLINE: "offline", MEDIA: "media", GROUP: "group", SYNCHRONIZATION: "synchronization", HYBRID: "hybrid" });

export class CommunicationFabricClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   */
  constructor(deps) {
    if (!deps?.axios) throw new Error("CommunicationFabricClient requires { axios }");
    this.axios = deps.axios;
    this._resultHandlers = new Set();
  }

  /** Subscribe to executed-communication results (for a debug/observability panel). @returns {() => void} */
  onResult(handler) {
    this._resultHandlers.add(handler);
    return () => this._resultHandlers.delete(handler);
  }

  // === the single entry point ===============================================

  /**
   * Execute a communication end-to-end through the Fabric. `senderId` is taken from the authenticated
   * caller server-side — never pass it.
   * @param {object} request a CommunicationRequest ({ type, recipients?/groupId?, mediaType?, priority?, payloadRef?, ... })
   * @returns {Promise<object>} the result view ({ decision, plan, execution, status })
   */
  async execute(request) {
    const { data } = await this.axios.post(`${BASE}/execute`, request);
    this._fan(data.result);
    return data.result;
  }

  /** Plan-only (dry run): decision + execution plan, NO orchestration. */
  async plan(request) {
    const { data } = await this.axios.post(`${BASE}/plan`, request);
    return data.result;
  }

  // === pipeline inspection ==================================================

  /** Build the immutable communication context for a request (debug/inspection). */
  async buildContext(request) {
    const { data } = await this.axios.post(`${BASE}/context`, request);
    return data.context;
  }

  /** Evaluate policies for a request (bias + constraints + refs + denial). */
  async evaluatePolicies(request) {
    const { data } = await this.axios.post(`${BASE}/policies`, request);
    return data.policies;
  }

  /** Get the decision (strategy + route + reasons) without executing. */
  async getStrategy(request) {
    const { data } = await this.axios.post(`${BASE}/strategy`, request);
    return data.decision;
  }

  /** Get the full execution plan without executing. */
  async getExecutionPlan(request) {
    const { data } = await this.axios.post(`${BASE}/execution-plan`, request);
    return data.plan;
  }

  /** Decision diagnostics + audit trail for a request. */
  async getDiagnostics(requestId) {
    const { data } = await this.axios.get(`${BASE}/diagnostics/${encodeURIComponent(requestId)}`);
    return data.diagnostics;
  }

  /** Fabric health (strategies, subsystems, policies, cache, metrics). */
  async health() {
    const { data } = await this.axios.get(`${BASE}/health`);
    return data.health;
  }

  // === convenience wrappers =================================================

  /** Send a direct 1:1 message through the Fabric. */
  sendDirect({ recipientId, payloadRef, priority } = {}) {
    return this.execute({ type: COMM_TYPE.DIRECT_MESSAGE, recipients: [recipientId], payloadRef, priority });
  }

  /** Send a group message through the Fabric. */
  sendGroup({ groupId, payloadRef, priority } = {}) {
    return this.execute({ type: COMM_TYPE.GROUP_MESSAGE, groupId, payloadRef, priority });
  }

  /** Send media through the Fabric. */
  sendMedia({ recipientId, groupId, mediaType, payloadRef, priority } = {}) {
    return this.execute({ type: COMM_TYPE.MEDIA_TRANSFER, recipients: recipientId ? [recipientId] : undefined, groupId, mediaType, payloadRef, priority });
  }

  /** Trigger a multi-device synchronization through the Fabric. */
  synchronize({ conversationId, sync } = {}) {
    return this.execute({ type: COMM_TYPE.SYNCHRONIZATION, conversationId, sync });
  }

  _fan(result) {
    for (const h of this._resultHandlers) {
      try {
        h(result);
      } catch {
        /* ignore */
      }
    }
  }
}

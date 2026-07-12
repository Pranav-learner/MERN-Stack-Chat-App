/**
 * Client Group Reliability integration (Layer 10, Sprint 3).
 *
 * Drives the `/api/group-reliability` engine: registers a group operation (group-message / fan-out /
 * rekey / membership-update / replica-sync / offline-delivery) for reliability tracking, reports
 * progress checkpoints, and requests recovery / resume when an operation is interrupted — so a group
 * send survives a crash, a dropped connection, or a stalled fan-out. It also surfaces read-only
 * observability (health, diagnostics, metrics, alerts) to an ops dashboard.
 *
 * @security This lib exchanges CONTROL-PLANE metadata + numeric aggregates ONLY with the engine — ids,
 * target counts, health scores, recovery reasons — never message content or keys. Recovery preserves
 * consistency (a resume re-runs only the remaining targets from a monotonic checkpoint).
 *
 * @scope Sprint 3 = reliability + recovery + monitoring + observability. Group read receipts / delivery
 * aggregation are Sprint 4 — the `onReceiptHook` here is an inert seam.
 *
 * @example
 * ```js
 * import { GroupReliabilityClient } from "../lib/groupReliability.js";
 * const rel = new GroupReliabilityClient({ axios, deviceId });
 * const op = await rel.register({ operationId, groupId, operationType: "fan-out", totalTargets: 40 });
 * await rel.checkpoint(op.operationId, { completedTargets: 40, cursor: 40, pendingTargets: 0 });
 * await rel.complete(op.operationId);
 * ```
 */

const BASE = "/api/group-reliability";

export class GroupReliabilityClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   * @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("GroupReliabilityClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.options = { autoRecover: true, ...(deps.options ?? {}) };
    this._healthHandlers = new Set();
    this._recoveryHandlers = new Set();
    this._receiptHandlers = new Set(); // FUTURE Sprint 4 read-receipt seam (inert)
  }

  /** Subscribe to health updates. @returns {() => void} */
  onHealth(handler) { this._healthHandlers.add(handler); return () => this._healthHandlers.delete(handler); }
  /** Subscribe to recovery outcomes. @returns {() => void} */
  onRecovery(handler) { this._recoveryHandlers.add(handler); return () => this._recoveryHandlers.delete(handler); }
  /** FUTURE Sprint 4 read-receipt seam — inert. @returns {() => void} */
  onReceiptHook(handler) { this._receiptHandlers.add(handler); return () => this._receiptHandlers.delete(handler); }

  // === operation lifecycle ==================================================

  /** Register a group operation for reliability tracking. */
  async register({ operationId, groupId, operationType, totalTargets, keyVersion, metadata } = {}) {
    const { data } = await this.axios.post(`${BASE}/operations`, { operationId, groupId, operationType, totalTargets, keyVersion, metadata });
    return data.operation;
  }

  /** Report a progress checkpoint (monotonic). */
  async checkpoint(operationId, progress = {}) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/checkpoint`, progress);
    this._fan(this._healthHandlers, data.operation?.health);
    return data.operation;
  }

  /** Mark the operation completed. */
  async complete(operationId) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/complete`);
    return data.operation;
  }

  /** Flag the operation interrupted (optionally auto-recover). */
  async interrupt(operationId, trigger, { autoRecover = this.options.autoRecover } = {}) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/interrupt`, { trigger, autoRecover });
    return data.operation;
  }

  /** Run a recovery for an interrupted operation. */
  async recover(operationId, trigger) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/recover`, { trigger });
    this._fan(this._recoveryHandlers, data);
    return data;
  }

  /** Resume the operation from its checkpoint. */
  async resume(operationId) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/resume`);
    return data;
  }

  /** Abandon (cancel) the operation. */
  async abandon(operationId, reason) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/abandon`, { reason });
    return data.operation;
  }

  // === reads + observability ================================================

  async getOperation(operationId) {
    const { data } = await this.axios.get(`${BASE}/operations/${encodeURIComponent(operationId)}`);
    return data.operation;
  }
  async getDiagnostics(operationId) {
    const { data } = await this.axios.get(`${BASE}/operations/${encodeURIComponent(operationId)}/diagnostics`);
    return data.diagnostics;
  }
  async listOperations({ state, limit } = {}) {
    const { data } = await this.axios.get(`${BASE}/operations`, { params: { state, limit } });
    return data.operations;
  }
  async groupHealth(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/health`);
    this._fan(this._healthHandlers, data.health);
    return data.health;
  }
  async groupAudit(groupId, limit) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/audit`, { params: { limit } });
    return data.audit;
  }
  async health() {
    const { data } = await this.axios.get(`${BASE}/health`);
    return data.health;
  }
  async metrics() {
    const { data } = await this.axios.get(`${BASE}/metrics`);
    return data.metrics;
  }
  async alerts({ limit, offset } = {}) {
    const { data } = await this.axios.get(`${BASE}/alerts`, { params: { limit, offset } });
    return data;
  }
  async protocol() {
    const { data } = await this.axios.get(`${BASE}/protocol`);
    return data.protocol;
  }

  _fan(handlers, payload) {
    for (const h of handlers) try { h(payload); } catch { /* ignore */ }
  }
}

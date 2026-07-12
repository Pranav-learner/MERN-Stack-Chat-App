/**
 * Client Media Reliability integration (Layer 11, Sprint 3).
 *
 * Drives the `/api/media-reliability` engine: registers a media operation (upload / download / streaming
 * / synchronization / pipeline) for reliability tracking, reports progress checkpoints, and requests
 * recovery / resume when a transfer is interrupted — so a large media upload/download survives a crash, a
 * dropped connection, or a storage blip and resumes from where it left off. It also surfaces read-only
 * observability (health, diagnostics, metrics, alerts) to an ops dashboard.
 *
 * @security This lib exchanges CONTROL-PLANE metadata + numeric aggregates ONLY with the engine — ids,
 * chunk/byte counts, health scores, recovery reasons — never media content or keys. Recovery preserves
 * integrity + metadata consistency (a resume re-transfers only the remaining chunks from a monotonic
 * checkpoint).
 *
 * @example
 * ```js
 * import { MediaReliabilityClient } from "../lib/mediaReliability.js";
 * const rel = new MediaReliabilityClient({ axios, deviceId });
 * const op = await rel.register({ operationId, mediaId, operationType: "upload", totalChunks: 40, bytesTotal: 10_000_000 });
 * await rel.checkpoint(op.operationId, { completedChunks: 40, cursor: 40, bytesTransferred: 10_000_000, pendingChunks: 0 });
 * await rel.complete(op.operationId);
 * ```
 */

const BASE = "/api/media-reliability";

export class MediaReliabilityClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("MediaReliabilityClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.options = { autoRecover: true, ...(deps.options ?? {}) };
    this._healthHandlers = new Set();
    this._recoveryHandlers = new Set();
  }

  /** Subscribe to health updates. @returns {() => void} */
  onHealth(handler) { this._healthHandlers.add(handler); return () => this._healthHandlers.delete(handler); }
  /** Subscribe to recovery outcomes. @returns {() => void} */
  onRecovery(handler) { this._recoveryHandlers.add(handler); return () => this._recoveryHandlers.delete(handler); }

  // === operation lifecycle ==================================================

  /** Register a media operation for reliability tracking. */
  async register({ operationId, mediaId, operationType, totalChunks, bytesTotal, storageProvider, metadata } = {}) {
    const { data } = await this.axios.post(`${BASE}/operations`, { operationId, mediaId, operationType, totalChunks, bytesTotal, storageProvider, metadata });
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
    return (await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/complete`)).data.operation;
  }

  /** Flag the operation interrupted (optionally auto-recover). */
  async interrupt(operationId, trigger, { autoRecover = this.options.autoRecover } = {}) {
    return (await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/interrupt`, { trigger, autoRecover })).data.operation;
  }

  /** Run a recovery for an interrupted operation (resume from checkpoint). */
  async recover(operationId, trigger) {
    const { data } = await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/recover`, { trigger });
    this._fan(this._recoveryHandlers, data);
    return data; // { outcome, record, resumePlan }
  }

  /** Resume the operation from its checkpoint (manual retry). */
  async resume(operationId) {
    return (await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/resume`)).data;
  }

  /** Abandon (cancel) the operation. */
  async abandon(operationId, reason) {
    return (await this.axios.post(`${BASE}/operations/${encodeURIComponent(operationId)}/abandon`, { reason })).data.operation;
  }

  // === reads + observability ================================================

  async getOperation(operationId) {
    return (await this.axios.get(`${BASE}/operations/${encodeURIComponent(operationId)}`)).data.operation;
  }
  async getDiagnostics(operationId) {
    return (await this.axios.get(`${BASE}/operations/${encodeURIComponent(operationId)}/diagnostics`)).data.diagnostics;
  }
  async listOperations({ state, limit } = {}) {
    return (await this.axios.get(`${BASE}/operations`, { params: { state, limit } })).data.operations;
  }
  async mediaHealth(mediaId) {
    const { data } = await this.axios.get(`${BASE}/media/${encodeURIComponent(mediaId)}/health`);
    this._fan(this._healthHandlers, data.health);
    return data.health;
  }
  async mediaAudit(mediaId, limit) {
    return (await this.axios.get(`${BASE}/media/${encodeURIComponent(mediaId)}/audit`, { params: { limit } })).data.audit;
  }
  async health() {
    return (await this.axios.get(`${BASE}/health`)).data.health;
  }
  async metrics() {
    return (await this.axios.get(`${BASE}/metrics`)).data.metrics;
  }
  async alerts({ limit, offset } = {}) {
    return (await this.axios.get(`${BASE}/alerts`, { params: { limit, offset } })).data;
  }
  async protocol() {
    return (await this.axios.get(`${BASE}/protocol`)).data.protocol;
  }

  _fan(handlers, payload) {
    for (const h of handlers) try { h(payload); } catch { /* ignore */ }
  }
}

/**
 * Client Offline-Synchronization integration (Layer 9, Sprint 1).
 *
 * Keeps this device's ENCRYPTED application state in sync with another device (or the server's
 * authoritative replica) against the `/api/synchronization` engine: it advertises this device's version
 * maps (its replica), asks the engine what it's MISSING, pulls the resulting operations, applies each
 * (fetching the already-encrypted content over the Layer-8 Data Plane), and reports progress. Supports
 * automatic / background / reconnect synchronization, resume, and failure recovery.
 *
 * @security This lib exchanges VERSION METADATA + entity IDs ONLY with the engine — never plaintext,
 * ciphertext, or keys. Building version maps + applying operations (fetch + decrypt content) are the
 * app's job, supplied as INJECTED hooks.
 *
 * @scope Sprint 1 = delta + planning + resumable sessions. Conflict resolution / merge / group sync are
 * Sprint 2 — the `onConflict` hook is an inert seam here.
 *
 * @example
 * ```js
 * import { SyncClient } from "../lib/synchronization.js";
 * const sync = new SyncClient({ axios, deviceId, buildVersions, applyOperation });
 * await sync.registerReplica();
 * sync.onProgress((p) => setBar(p.progress));
 * await sync.synchronize({ sourceDeviceId: "server" });   // one full sync
 * sync.startBackgroundSync({ sourceDeviceId: "server", intervalMs: 30000 });
 * ```
 */

const BASE = "/api/synchronization";

export class SyncClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   * @param {() => (object|Promise<object>)} deps.buildVersions produce this device's category version maps
   * @param {(operation: object) => Promise<boolean>} deps.applyOperation fetch + apply an operation's entities (returns success)
   * @param {object} [deps.options] `{ batchSize?, maxPerPull? }`
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("SyncClient requires { axios, deviceId }");
    if (typeof deps.buildVersions !== "function") throw new Error("SyncClient requires a buildVersions() hook");
    if (typeof deps.applyOperation !== "function") throw new Error("SyncClient requires an applyOperation(op) hook");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.buildVersions = deps.buildVersions;
    this.applyOperation = deps.applyOperation;
    this.options = { batchSize: 100, maxPerPull: 20, ...(deps.options ?? {}) };
    this._progressHandlers = new Set();
    this._conflictHandlers = new Set(); // FUTURE Sprint 2 seam (inert)
    this._bgTimer = null;
    this._syncing = false;
  }

  /** Subscribe to progress updates. @returns {() => void} */
  onProgress(handler) {
    this._progressHandlers.add(handler);
    return () => this._progressHandlers.delete(handler);
  }

  /** FUTURE Sprint 2 seam — register a conflict handler (inert in Sprint 1). @returns {() => void} */
  onConflict(handler) {
    this._conflictHandlers.add(handler);
    return () => this._conflictHandlers.delete(handler);
  }

  /** Advertise this device's current replica (version maps) to the engine. */
  async registerReplica() {
    const categoryVersions = await this.buildVersions();
    const { data } = await this.axios.post(`${BASE}/replicas`, { categoryVersions });
    return data.replica;
  }

  /** Ask the engine what this device is missing relative to a source (read-only). */
  async computeMissing({ sourceDeviceId, sourceReplicaId, categories, since } = {}) {
    const { data } = await this.axios.post(`${BASE}/delta`, { sourceDeviceId, sourceReplicaId, categories, since });
    return data.delta;
  }

  /**
   * Run one full synchronization: register the replica, start a session, and drain its operations to
   * completion (applying each + reporting progress). Resumes gracefully if interrupted.
   * @param {{ sourceDeviceId?: string, sourceReplicaId?: string, categories?: string[], since?: object }} params
   * @returns {Promise<object>} the final status
   */
  async synchronize(params = {}) {
    if (this._syncing) return { skipped: "already-syncing" };
    this._syncing = true;
    try {
      await this.registerReplica();
      const { data } = await this.axios.post(`${BASE}/sessions`, { ...params, batchSize: this.options.batchSize });
      const sessionId = data.session.sessionId;
      this._emitProgress(data.session.progress ?? { progress: 0 });
      if (data.session.state === "completed") return data.session;
      return await this._drain(sessionId);
    } finally {
      this._syncing = false;
    }
  }

  /** @private drain a session to a terminal state. */
  async _drain(sessionId) {
    for (;;) {
      const { data: opsData } = await this.axios.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}/operations`, { params: { max: this.options.maxPerPull } });
      const operations = opsData.operations ?? [];
      if (operations.length === 0) {
        const { data } = await this.axios.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}/status`);
        if (data.status.terminal) return data.status;
        // no ops but not terminal → paused/backpressure; stop and let the caller resume later.
        return data.status;
      }
      const appliedOpIds = [];
      const failedOpIds = [];
      for (const op of operations) {
        try {
          const ok = await this.applyOperation(op);
          (ok !== false ? appliedOpIds : failedOpIds).push(op.opId);
        } catch {
          failedOpIds.push(op.opId);
        }
      }
      const { data } = await this.axios.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/progress`, { appliedOpIds, failedOpIds });
      this._emitProgress(data.status);
      if (data.status.terminal) return data.status;
    }
  }

  /** Pause / resume / cancel a session. */
  async pause(sessionId) {
    return (await this.axios.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pause`)).data.session;
  }
  async resume(sessionId) {
    await this.axios.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/resume`);
    return this._drain(sessionId);
  }
  async cancel(sessionId) {
    return (await this.axios.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/cancel`)).data.session;
  }

  /** Start periodic background synchronization. Idempotent. */
  startBackgroundSync(params = {}) {
    if (this._bgTimer) return;
    const intervalMs = params.intervalMs ?? 30_000;
    this._bgTimer = setInterval(() => this.synchronize(params).catch(() => {}), intervalMs);
    this.synchronize(params).catch(() => {}); // kick off immediately
  }

  /** Stop background synchronization. */
  stopBackgroundSync() {
    if (this._bgTimer) clearInterval(this._bgTimer);
    this._bgTimer = null;
  }

  /** Trigger a synchronization on reconnect (call from your connection-restored handler). */
  async onReconnect(params = {}) {
    return this.synchronize(params);
  }

  _emitProgress(progress) {
    for (const handler of this._progressHandlers) {
      try {
        handler(progress);
      } catch {
        /* a progress handler must not break the sync loop */
      }
    }
  }
}

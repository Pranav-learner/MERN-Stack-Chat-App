/**
 * Client State-Replication integration (Layer 9, Sprint 2).
 *
 * Makes this device a secure encrypted REPLICA and keeps it eventually consistent with another device
 * (or the server's authoritative replica) against the `/api/replication` engine: it advertises this
 * device's version records, compares against a source, synchronizes (resolving conflicts + merging
 * deterministically), replicates deltas, and resumes interrupted synchronization. Conflicts are
 * surfaced to the app for notification; the merge itself runs on the server engine.
 *
 * @security This lib exchanges VERSION METADATA + entity IDs + non-secret merge metadata ONLY with the
 * engine — never plaintext, ciphertext, or keys. Building the version records (a `contentHash` per
 * entity) + applying a merged winner locally are the app's job, supplied as INJECTED hooks.
 *
 * @scope Sprint 2 = deterministic replication + conflict resolution + merge + resume. Group replication
 * / hybrid mode are later — the `onGroupReplication` hook is an inert seam.
 *
 * @example
 * ```js
 * import { ReplicationClient } from "../lib/replication.js";
 * const repl = new ReplicationClient({ axios, deviceId, buildReplica, applyMerged });
 * repl.onConflict(({ category, entityId }) => notifyUser(category, entityId));
 * await repl.registerReplica();
 * await repl.synchronize({ sourceDeviceId: "server", policy: "merge" });
 * ```
 */

const BASE = "/api/replication";

export class ReplicationClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   * @param {() => (object|Promise<object>)} deps.buildReplica produce this device's category version records
   * @param {(merged: object) => Promise<void>} [deps.applyMerged] apply the converged state locally (optional)
   * @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("ReplicationClient requires { axios, deviceId }");
    if (typeof deps.buildReplica !== "function") throw new Error("ReplicationClient requires a buildReplica() hook");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.buildReplica = deps.buildReplica;
    this.applyMerged = deps.applyMerged ?? null;
    this.options = { autoIntervalMs: 45_000, ...(deps.options ?? {}) };
    this._conflictHandlers = new Set();
    this._healthHandlers = new Set();
    this._groupHandlers = new Set(); // FUTURE group-replication seam (inert)
    this._autoTimer = null;
  }

  /** Subscribe to conflict notifications. @returns {() => void} */
  onConflict(handler) {
    this._conflictHandlers.add(handler);
    return () => this._conflictHandlers.delete(handler);
  }

  /** Subscribe to replica-health updates. @returns {() => void} */
  onReplicaHealth(handler) {
    this._healthHandlers.add(handler);
    return () => this._healthHandlers.delete(handler);
  }

  /** FUTURE group-replication seam — inert in Sprint 2. @returns {() => void} */
  onGroupReplication(handler) {
    this._groupHandlers.add(handler);
    return () => this._groupHandlers.delete(handler);
  }

  /** Advertise this device's current replica (version records) to the engine. */
  async registerReplica() {
    const { categories, metadata } = await this._buildReplica();
    const { data } = await this.axios.post(`${BASE}/replicas`, { categories, metadata });
    this._emitHealth(data.replica);
    return data.replica;
  }

  /** Compare this device against a source replica (what diverges?). */
  async compare({ sourceDeviceId, sourceReplicaId, categories } = {}) {
    const { data } = await this.axios.post(`${BASE}/compare`, { sourceDeviceId, sourceReplicaId, categories });
    for (const conflict of data.comparison.conflicts ?? []) this._emitConflict(conflict);
    return data.comparison;
  }

  /**
   * Synchronize this device with a source: register the replica, then synchronize (resolve + merge).
   * The converged state is applied locally via `applyMerged` (if provided). @returns {Promise<object>}
   * @param {{ sourceDeviceId?: string, sourceReplicaId?: string, categories?: string[], policy?: string|object, authorityReplicaId?: string }} params
   */
  async synchronize(params = {}) {
    await this.registerReplica();
    const { data } = await this.axios.post(`${BASE}/synchronize`, params);
    for (const conflict of data.comparison?.conflicts ?? []) this._emitConflict(conflict);
    if (this.applyMerged && data.merge?.merged) await this.applyMerged(data.merge.merged);
    return data;
  }

  /** Resolve a single conflict explicitly (e.g. after user choice). */
  async resolveConflict({ sourceDeviceId, sourceReplicaId, category, entityId, policy }) {
    const { data } = await this.axios.post(`${BASE}/resolve`, { sourceDeviceId, sourceReplicaId, category, entityId, policy });
    return data.resolution;
  }

  /** Replicate an incremental delta (catch-up) from a source. */
  async replicateDelta({ sourceDeviceId, sourceReplicaId, categories, maxItems } = {}) {
    const { data } = await this.axios.post(`${BASE}/delta`, { sourceDeviceId, sourceReplicaId, categories, maxItems });
    return data;
  }

  /** Resume an interrupted synchronization from a cursor (recovers partial transfers). */
  async resume({ sourceDeviceId, sourceReplicaId, cursor, categories } = {}) {
    const { data } = await this.axios.post(`${BASE}/resume`, { sourceDeviceId, sourceReplicaId, cursor, categories });
    return data;
  }

  /** This device's replica health/status. */
  async getReplicaHealth() {
    const { data } = await this.axios.get(`${BASE}/replicas/me`);
    this._emitHealth(data.replica);
    return data.replica;
  }

  /** Start automatic periodic replica comparison + synchronization. Idempotent. */
  startAutoReplication(params = {}) {
    if (this._autoTimer) return;
    const intervalMs = params.intervalMs ?? this.options.autoIntervalMs;
    this._autoTimer = setInterval(() => this.synchronize(params).catch(() => {}), intervalMs);
    this.synchronize(params).catch(() => {});
  }

  /** Stop automatic replication. */
  stopAutoReplication() {
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._autoTimer = null;
  }

  /** Trigger replication on reconnect. */
  async onReconnect(params = {}) {
    return this.synchronize(params);
  }

  async _buildReplica() {
    const built = await this.buildReplica();
    return { categories: built.categories ?? built, metadata: built.metadata };
  }
  _emitConflict(conflict) {
    for (const h of this._conflictHandlers) try { h(conflict); } catch { /* ignore */ }
  }
  _emitHealth(replica) {
    for (const h of this._healthHandlers) try { h(replica); } catch { /* ignore */ }
  }
}

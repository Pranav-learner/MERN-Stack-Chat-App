/**
 * @module replication/manager
 *
 * The **Replica Manager** — the reusable orchestrator for Layer 9, Sprint 2. It treats every
 * authenticated device as a secure encrypted REPLICA, tracks each replica's per-entity versions,
 * compares replicas, detects + resolves conflicts by configurable policy, applies DETERMINISTIC merges,
 * replicates deltas (safe monotonic catch-up), and resumes interrupted synchronization.
 *
 * @important Reasons over VERSION METADATA + entity IDs + non-secret merge metadata ONLY — never
 * plaintext, ciphertext, or keys. Every merge + resolution is deterministic, so replicas converge to
 * eventual consistency without a coordinator. This sprint uses a scalar version stamp (a vector-clock
 * seam); it does NOT implement vector clocks, CRDTs, consensus, monitoring, or performance hardening.
 *
 * @evolution Transport-INDEPENDENT. Group replication + hybrid mode reuse this manager; the event bus
 * is the seam a FUTURE Layer 10 consumes.
 *
 * @example
 * ```js
 * const mgr = new ReplicaManager({ ...createInMemoryReplicationRepository() });
 * await mgr.registerReplica({ deviceId: "phone", userId: "u1", categories });
 * await mgr.registerReplica({ deviceId: "laptop", userId: "u1", categories });
 * const result = await mgr.synchronizeReplicas({ sourceDeviceId: "phone", targetDeviceId: "laptop", policy: "last-write-wins" });
 * // result.merge.merged is the converged state now stored on BOTH replicas
 * ```
 */

import crypto from "node:crypto";
import {
  ReplicationEventType,
  ReplicationFailureReason,
  DEFAULT_CATEGORY_POLICY,
} from "../types/types.js";
import { ReplicationError } from "../errors.js";
import { createReplicaSnapshot, applyRecord, replicaSummary, totalEntities, getRecord, setRecord, normalizeRecord } from "../replicas/replicaModel.js";
import { compareReplicas } from "../conflicts/conflictDetector.js";
import { ConflictResolver } from "../conflicts/conflictResolver.js";
import { mergeReplicas, validateMerge } from "../merge/mergeEngine.js";
import { generateReplicationDelta, applyDelta, validateDelta, resumeDelta, planTransferResume, ReplayGuard } from "../delta/deltaReplicator.js";
import { versionHistoryEntry } from "../versions/versionStamp.js";
import { createHistory } from "../history/history.js";
import { ReplicationEventBus } from "../events/events.js";
import {
  validateReplicaRegistration,
  validateCategories,
  validateConflictPolicy,
  validateRef,
  requireReplica,
  assertOwner,
  assertNoPlaintext,
  validateRepository,
} from "../validators/validators.js";
import { toPublicReplica, toComparison, toMergeResult, toResolution, toDelta } from "../serializers/serializer.js";

export class ReplicaManager {
  constructor(deps = {}) {
    validateRepository({ replicas: deps.replicas });
    this.replicas = deps.replicas;
    this.history = createHistory(deps);
    this.events = deps.events ?? new ReplicationEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.authorityReplicaId = deps.authorityReplicaId ?? null;
    this.defaultPolicies = deps.policies ?? {};
    this.customResolvers = deps.customResolvers ?? {};
    this.transferHooks = deps.transferHooks ?? {};
    this.replayGuard = deps.replayGuard ?? new ReplayGuard();
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === replica management ==================================================

  /** Register (or update) a device's replica. Idempotent. @returns {Promise<object>} */
  async registerReplica(params) {
    validateReplicaRegistration(params);
    const existing = params.replicaId ? await this.replicas.findById(params.replicaId) : await this.replicas.findByDevice(params.deviceId);
    if (existing) return this.updateReplica(existing.replicaId, { categories: params.categories, metadata: params.metadata });
    const snapshot = createReplicaSnapshot({ ...params, clock: this.clock, idGenerator: this.idGenerator });
    assertNoPlaintext(snapshot, "replica");
    const stored = await this.replicas.upsert(snapshot);
    await this.history.recordReplica({ replicaId: stored.replicaId, event: "registered", at: this._nowIso() });
    this.events.emit(ReplicationEventType.REPLICA_REGISTERED, { replicaId: stored.replicaId, deviceId: stored.deviceId, userId: stored.userId });
    return toPublicReplica(stored);
  }

  /** Apply local edits to a replica (monotonic incremental version updates). @returns {Promise<object>} */
  async updateReplica(replicaId, patch = {}, options = {}) {
    validateRef(replicaId, "replica identifier");
    let replica = requireReplica(await this.replicas.findById(String(replicaId)), replicaId);
    if (options.actingDevice) assertOwner(replica, options.actingDevice);
    const changed = [];
    if (patch.categories) {
      validateCategories(patch.categories);
      for (const [category, entities] of Object.entries(patch.categories)) {
        for (const [entityId, rec] of Object.entries(entities ?? {})) {
          const record = normalizeRecord(entityId, rec);
          const res = applyRecord(replica, category, record);
          replica = res.snapshot;
          if (res.changed) changed.push({ category, record });
        }
      }
    }
    const updated = await this.replicas.update(replicaId, {
      categories: replica.categories,
      metadata: patch.metadata ? { ...(replica.metadata ?? {}), ...patch.metadata } : replica.metadata,
      replicaVersion: (replica.replicaVersion ?? 1) + (changed.length ? 1 : 0),
      version: (replica.version ?? 0) + 1,
    });
    for (const { category, record } of changed) await this.history.recordVersion({ replicaId: updated.replicaId, ...versionHistoryEntry(category, record, this._nowIso()) });
    this.events.emit(ReplicationEventType.REPLICA_UPDATED, { replicaId: updated.replicaId, deviceId: updated.deviceId, replicaVersion: updated.replicaVersion, changed: changed.length });
    return toPublicReplica(updated);
  }

  /** A replica's public status (summary + counts). */
  async getReplicaStatus({ replicaId, deviceId, actingDevice } = {}) {
    const replica = await this._resolve({ replicaId, deviceId });
    if (actingDevice) assertOwner(replica, actingDevice);
    return { ...toPublicReplica(replica), totalEntities: totalEntities(replica) };
  }

  /** List a user's replicas. */
  async listReplicas({ userId }) {
    return (await this.replicas.listByUser(userId)).map(toPublicReplica);
  }

  // === comparison ==========================================================

  /** Compare two replicas (what diverges?). Read-only. @returns {Promise<object>} */
  async compareReplicas(params, options = {}) {
    const source = await this._resolve({ replicaId: params.sourceReplicaId, deviceId: params.sourceDeviceId });
    const target = await this._resolve({ replicaId: params.targetReplicaId, deviceId: params.targetDeviceId });
    if (options.actingDevice) assertOwner(target, options.actingDevice);
    const comparison = compareReplicas(source, target, { categories: params.categories });
    this.events.emit(ReplicationEventType.REPLICA_COMPARED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, conflicts: comparison.totals.conflicts, merges: comparison.totals.merges });
    return toComparison(comparison, source, target);
  }

  // === synchronization (compare → resolve → merge → persist) ===============

  /**
   * Synchronize two replicas: compare, resolve conflicts by policy, merge deterministically, and store
   * the converged state on BOTH replicas (eventual consistency). @returns {Promise<object>}
   * @param {{ sourceReplicaId?, sourceDeviceId?, targetReplicaId?, targetDeviceId?, categories?, policy?, authorityReplicaId?, customResolvers? }} params
   */
  async synchronizeReplicas(params, options = {}) {
    const source = await this._resolve({ replicaId: params.sourceReplicaId, deviceId: params.sourceDeviceId });
    const target = await this._resolve({ replicaId: params.targetReplicaId, deviceId: params.targetDeviceId });
    if (options.actingDevice) assertOwner(target, options.actingDevice);
    const resolver = this._resolver(params);

    const comparison = compareReplicas(source, target, { categories: params.categories });
    for (const c of comparison.conflicts) {
      this.events.emit(ReplicationEventType.CONFLICT_DETECTED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, category: c.category, entityId: c.entityId });
      await this.history.recordConflict({ sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, category: c.category, entityId: c.entityId, status: "detected" });
    }

    this.events.emit(ReplicationEventType.MERGE_STARTED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId });
    const now = this._nowIso();
    const result = mergeReplicas(source, target, { conflictResolver: resolver, categories: params.categories, clock: this.clock });
    validateMerge(result.merged, source, target, params.categories);

    for (const r of result.resolutions) {
      this.events.emit(ReplicationEventType.CONFLICT_RESOLVED, { category: r.category, entityId: r.entityId, policy: r.policy, winner: r.winner?.writerReplicaId });
      await this.history.recordConflict({ sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, category: r.category, entityId: r.entityId, policy: r.policy, reason: r.reason, status: "resolved" });
    }

    // Persist the converged state on BOTH replicas (each keeps its own identity).
    await this._store(target, result.merged.categories, result.merged.replicaVersion);
    await this._store(source, result.merged.categories, result.merged.replicaVersion);

    await this.history.recordMerge({ sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, resolved: result.resolutions.length, merged: result.merges.length, at: now });
    this.events.emit(ReplicationEventType.MERGE_COMPLETED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, resolved: result.resolutions.length, merged: result.merges.length });
    this.events.emit(ReplicationEventType.DELTA_REPLICATED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, items: comparison.totals.onlyInSource + comparison.totals.fastForwardTarget });

    return { comparison: toComparison(comparison, source, target), merge: toMergeResult(result), resolutions: result.resolutions.map(toResolution) };
  }

  /** Alias — merge two replicas (same as synchronize; the converged state is persisted). */
  async mergeReplica(params, options = {}) {
    return this.synchronizeReplicas(params, options);
  }

  /** Resolve a SINGLE conflict explicitly (manual resolution) + apply the winner to both replicas. */
  async resolveConflict(params, options = {}) {
    validateConflictPolicy(params.policy);
    const source = await this._resolve({ replicaId: params.sourceReplicaId, deviceId: params.sourceDeviceId });
    const target = await this._resolve({ replicaId: params.targetReplicaId, deviceId: params.targetDeviceId });
    if (options.actingDevice) assertOwner(target, options.actingDevice);
    validateRef(params.category, "category");
    validateRef(params.entityId, "entity identifier");
    const s = getRecord(source, params.category, params.entityId);
    const t = getRecord(target, params.category, params.entityId);
    if (!s || !t) throw new ReplicationError("Both replicas must hold the entity to resolve a conflict", { code: "ERR_REPLICATION_VALIDATION", status: 400, details: { entityId: params.entityId } });
    const resolver = this._resolver(params);
    const resolution = resolver.resolve({ category: params.category, entityId: params.entityId, source: s, target: t }, { now: this._nowIso() });

    const targetStored = setRecord(target, params.category, resolution.winner);
    const sourceStored = setRecord(source, params.category, resolution.winner);
    await this._store(target, targetStored.categories, (target.replicaVersion ?? 1) + 1);
    await this._store(source, sourceStored.categories, (source.replicaVersion ?? 1) + 1);
    await this.history.recordConflict({ sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, category: params.category, entityId: params.entityId, policy: resolution.policy, reason: resolution.reason, status: "resolved" });
    this.events.emit(ReplicationEventType.CONFLICT_RESOLVED, { category: params.category, entityId: params.entityId, policy: resolution.policy });
    return toResolution({ category: params.category, entityId: params.entityId, ...resolution, sourceVersion: s.version, targetVersion: t.version });
  }

  // === delta replication + resume ==========================================

  /** Replicate an incremental delta from source → target (safe monotonic catch-up + lossless merges). */
  async replicateDelta(params, options = {}) {
    const source = await this._resolve({ replicaId: params.sourceReplicaId, deviceId: params.sourceDeviceId });
    const target = await this._resolve({ replicaId: params.targetReplicaId, deviceId: params.targetDeviceId });
    if (options.actingDevice) assertOwner(target, options.actingDevice);
    const delta = generateReplicationDelta(source, target, { categories: params.categories, maxItems: params.maxItems, now: this.clock() });
    validateDelta(delta);
    this.replayGuard.check(delta.deltaId);
    const { snapshot, applied, skipped } = applyDelta(target, delta);
    await this._store(target, snapshot.categories, (target.replicaVersion ?? 1) + (applied ? 1 : 0));
    await this.history.recordDelta({ sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, deltaId: delta.deltaId, applied, skipped, partial: delta.partial });
    this.events.emit(ReplicationEventType.DELTA_REPLICATED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, applied, skipped });
    const resume = planTransferResume(delta, { transferHooks: this.transferHooks, now: this.clock() });
    return { delta: toDelta(delta), applied, skipped, resume };
  }

  /** Resume an interrupted delta replication from a cursor (partial-transfer recovery). */
  async resumeSynchronization(params, options = {}) {
    const source = await this._resolve({ replicaId: params.sourceReplicaId, deviceId: params.sourceDeviceId });
    const target = await this._resolve({ replicaId: params.targetReplicaId, deviceId: params.targetDeviceId });
    if (options.actingDevice) assertOwner(target, options.actingDevice);
    const cursor = params.cursor ?? 0;
    const full = generateReplicationDelta(source, target, { categories: params.categories, now: this.clock() });
    const remaining = resumeDelta(full, cursor);
    const { snapshot, applied, skipped } = applyDelta(target, remaining);
    await this._store(target, snapshot.categories, (target.replicaVersion ?? 1) + (applied ? 1 : 0));
    const resume = planTransferResume(remaining, { transferHooks: this.transferHooks, now: this.clock() });
    this.events.emit(ReplicationEventType.SYNCHRONIZATION_RESUMED, { sourceReplicaId: source.replicaId, targetReplicaId: target.replicaId, cursor, applied });
    return { applied, skipped, cursor, resumedItems: remaining.records.length, resume };
  }

  // === history + diagnostics ===============================================

  /** Version history for a replica (optionally filtered by category / entity). */
  async getVersionHistory({ replicaId, category, entityId, limit }) {
    validateRef(replicaId, "replica identifier");
    let list = await this.history.listVersions(replicaId, { limit });
    if (category) list = list.filter((e) => e.category === category);
    if (entityId) list = list.filter((e) => e.entityId === entityId);
    return list;
  }

  /** Conflict history for a replica. */
  async getConflictHistory({ replicaId, limit }) {
    validateRef(replicaId, "replica identifier");
    return this.history.listConflicts(replicaId, { limit });
  }

  /** Diagnostics for a replica (summary + recent conflicts/merges). */
  async getDiagnostics({ replicaId, actingDevice }) {
    const replica = await this._resolve({ replicaId });
    if (actingDevice) assertOwner(replica, actingDevice);
    return {
      replica: { ...toPublicReplica(replica), totalEntities: totalEntities(replica) },
      recentConflicts: await this.history.listConflicts(replicaId, { limit: 20 }),
      recentMerges: await this.history.listMerges(replicaId, { limit: 20 }),
    };
  }

  /** Aggregate control-plane health. */
  async health() {
    return { framework: "replication", stampKind: "scalar", authorityReplicaId: this.authorityReplicaId, at: this._nowIso() };
  }

  // === internals ==========================================================

  /** @private build a resolver from request overrides + manager defaults. */
  _resolver(params = {}) {
    let policies = { ...this.defaultPolicies };
    let defaultPolicy;
    if (typeof params.policy === "string") {
      validateConflictPolicy(params.policy);
      defaultPolicy = params.policy;
    } else if (params.policy && typeof params.policy === "object") {
      for (const [c, p] of Object.entries(params.policy)) {
        validateConflictPolicy(p);
        policies[c] = p;
      }
    }
    return new ConflictResolver({ policies, defaultPolicy, authorityReplicaId: params.authorityReplicaId ?? this.authorityReplicaId, customResolvers: { ...this.customResolvers, ...(params.customResolvers ?? {}) } });
  }

  /** @private persist a snapshot's categories + bumped versions. */
  async _store(replica, categories, replicaVersion) {
    assertNoPlaintext(categories, "categories");
    return this.replicas.update(replica.replicaId, { categories, replicaVersion, version: (replica.version ?? 0) + 1 });
  }

  /** @private resolve a replica by id or device. */
  async _resolve({ replicaId, deviceId }) {
    const replica = replicaId ? await this.replicas.findById(replicaId) : await this.replicas.findByDevice(deviceId);
    return requireReplica(replica, replicaId ?? deviceId);
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/**
 * @module synchronization/serializers
 *
 * Public DTOs for the Synchronization Engine. Whitelists PUBLIC fields for replicas, sessions, plans,
 * deltas, and progress. All views carry VERSION METADATA + counts only — never content.
 *
 * @security No DTO carries plaintext/keys. Version maps are summarized (per-category counts + high-
 * water versions) rather than dumped entity-by-entity, keeping payloads small + opaque.
 */

import { TERMINAL_SESSION_STATES, SyncSessionState, ALL_SYNC_CATEGORIES } from "../types/types.js";
import { replicaSummary } from "../state/replicaState.js";

const TERMINAL = new Set(TERMINAL_SESSION_STATES);

/** A replica's public DTO (per-category summary, no raw entity maps). */
export function toPublicReplica(replica) {
  if (!replica) return null;
  return { ...replicaSummary(replica), userId: replica.userId, pendingChanges: replica.pendingChanges ?? 0, updatedAt: replica.updatedAt, version: replica.version, schemaVersion: replica.schemaVersion };
}

/** A session's public DTO. */
export function toPublicSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    sourceReplicaId: session.sourceReplicaId,
    targetReplicaId: session.targetReplicaId,
    deviceId: session.deviceId,
    userId: session.userId,
    direction: session.direction,
    state: session.state,
    categories: session.categories,
    progress: toProgress(session),
    terminal: TERMINAL.has(session.state),
    completed: session.state === SyncSessionState.COMPLETED,
    planId: session.planId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    version: session.version,
  };
}

/** A compact progress view. */
export function toProgress(session) {
  const total = session.progress?.totalOperations ?? 0;
  const done = session.progress?.completedOperations ?? 0;
  return {
    sessionId: session.sessionId,
    state: session.state,
    totalOperations: total,
    completedOperations: done,
    totalItems: session.progress?.totalItems ?? 0,
    appliedItems: session.progress?.appliedItems ?? 0,
    progress: total > 0 ? done / total : session.state === SyncSessionState.COMPLETED ? 1 : 0,
    resumeCursor: session.resumeCursor ?? 0,
    terminal: TERMINAL.has(session.state),
  };
}

/** A plan's public DTO (operation summaries, not full entity ref dumps). */
export function toPublicPlan(plan, options = {}) {
  if (!plan) return null;
  const dto = {
    planId: plan.planId,
    sessionId: plan.sessionId,
    totalOperations: plan.totalOperations,
    totalItems: plan.totalItems,
    plannedItems: plan.plannedItems,
    remainingItems: plan.remainingItems,
    partial: plan.partial,
    batchSize: plan.batchSize,
    estimatedBytes: plan.estimatedBytes,
    ordering: plan.ordering,
    deterministicHash: plan.deterministicHash,
    createdAt: plan.createdAt,
  };
  if (options.includeOperations) {
    dto.operations = (plan.operations ?? []).map((op) => ({ opId: op.opId, category: op.category, priority: op.priority, itemCount: op.itemCount, batchIndex: op.batchIndex, estimatedBytes: op.estimatedBytes, state: op.state }));
  }
  return dto;
}

/** A delta's public DTO (per-category counts; entity refs only if requested). */
export function toPublicDelta(delta, options = {}) {
  if (!delta) return null;
  const categories = {};
  for (const category of Object.keys(delta.categories ?? {})) {
    categories[category] = { count: delta.categories[category].count, ...(options.includeRefs ? { missing: delta.categories[category].missing } : {}) };
  }
  return { totalItems: delta.totalItems, categories, metadata: delta.metadata };
}

/** A dispatched operation's client view (entity refs the client fetches/applies). */
export function toOperation(op) {
  return { opId: op.opId, sessionId: op.sessionId, category: op.category, entityRefs: op.entityRefs, itemCount: op.itemCount, batchIndex: op.batchIndex, estimatedBytes: op.estimatedBytes };
}

/** A compact sync-status view. */
export function toSyncStatus(session) {
  return { sessionId: session.sessionId, state: session.state, ...toProgress(session), terminal: TERMINAL.has(session.state) };
}

export { ALL_SYNC_CATEGORIES };

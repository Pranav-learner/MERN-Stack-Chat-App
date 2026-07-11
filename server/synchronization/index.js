/**
 * @module synchronization
 *
 * **Layer 9 · Sprint 1 — Offline Synchronization Engine.** Securely synchronizes ENCRYPTED application
 * state (messages, conversations, delivery state, read receipts, attachment metadata, transfer
 * metadata, device metadata) across a user's authenticated devices by computing state differences
 * (delta detection), generating DETERMINISTIC synchronization plans, and executing resumable
 * synchronization SESSIONS.
 *
 * @security Reasons over VERSION METADATA + entity IDs ONLY — never plaintext, ciphertext, or keys. The
 * already-encrypted content is transported by the Layer-8 Data Plane; this engine only decides *what*
 * is missing + *how* to sync it.
 *
 * @evolution Transport-INDEPENDENT (produces plans + operations; the client executes them over any
 * transport). It does NOT implement conflict resolution, replica merge, distributed consensus, or group
 * synchronization — those are Sprint 2, which consumes the events + reuses the version maps + plans.
 *
 * @example
 * ```js
 * import { SynchronizationManager, createInMemorySyncRepository, createSyncApi } from "./synchronization/index.js";
 * const mgr = new SynchronizationManager({ ...createInMemorySyncRepository() });
 * const api = createSyncApi(mgr);
 * await api.registerReplica({ deviceId: "phone", userId: "u1", categoryVersions });
 * const { session, plan } = await api.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { SyncEventBus } from "./events/events.js";

// Replica state + delta
export { createReplica, applyEntityVersions, replicaSummary, normalizeCategoryVersions, categoryHighWater, totalEntities } from "./state/replicaState.js";
export { computeDelta, estimateDeltaBytes, isDeltaEmpty, validateDelta, compressDelta } from "./delta/deltaDetector.js";

// Planner + sessions + queue
export { createSyncPlan, remainingOperations, hashPlan, validatePlan } from "./planner/syncPlanner.js";
export { ALLOWED_TRANSITIONS, canTransition, assertTransition, nextStates, SessionLifecycle } from "./sessions/sessionLifecycle.js";
export { SyncQueue } from "./queue/syncQueue.js";

// Validators + serializers
export * from "./validators/validators.js";
export { toPublicReplica, toPublicSession, toPublicPlan, toPublicDelta, toProgress, toOperation, toSyncStatus } from "./serializers/serializer.js";

// Repositories
export { createInMemorySyncRepository } from "./repository/inMemorySyncRepository.js";
export { createMongoSyncRepository } from "./repository/mongoSyncRepository.js";

// Manager + API
export { SynchronizationManager } from "./manager/synchronizationManager.js";
export { createSyncApi } from "./api/syncApi.js";

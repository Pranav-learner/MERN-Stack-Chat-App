/**
 * @module group-communication
 *
 * **Layer 10 · Sprint 2 — Group Communication Engine.** Turns the Sprint-1 Group Foundation into a
 * live, end-to-end-encrypted channel: secure group messaging, group key management + membership
 * rekeying, intelligent multi-device fan-out, group synchronization, and offline-member support.
 *
 * @security The engine is a control plane + BLIND relay — it stores group-key METADATA (versions +
 * opaque fingerprints) and OPAQUE ciphertext ONLY, never key bytes or plaintext. Group keys are derived
 * + held device-local with the Layer 5 HKDF primitives.
 *
 * @evolution Reuses Layer 5 (key hierarchy HKDF), Layer 8 (reliable messaging — injected fan-out send
 * hook), Layer 9 (synchronization delta model), and the Sprint-1 Group Manager (membership directory).
 * It does NOT implement production monitoring / hardening (Sprint 3) or group read receipts / delivery
 * aggregation (Sprint 4) — the events are the seam those consume.
 *
 * @example
 * ```js
 * import { GroupCommunicationEngine, createInMemoryGroupCommRepository, createGroupCommunicationApi, createGroupDirectoryFromManager } from "./group-communication/index.js";
 * const engine = new GroupCommunicationEngine({ ...createInMemoryGroupCommRepository(), directory: createGroupDirectoryFromManager(groupManager), messagingSend });
 * const api = createGroupCommunicationApi(engine);
 * await api.establishGroupKey({ groupId, actorId: "alice" });
 * await api.sendGroupMessage({ groupId, senderId: "alice", senderDeviceId: "alice-web", ciphertext });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { GroupCommEventBus } from "./events/events.js";

// Key management + rekeying
export { deriveGroupKey, groupKeyFingerprint, groupKeyId, memberSetHash, freshEpochSecret, nextEpochSecret, disposeGroupKey, createLocalKeyProvider, groupKeySalt } from "./key-management/groupKey.js";
export { GroupKeyManager, canKeyTransition, assertKeyTransition } from "./key-management/keyManager.js";
export { planRekey, rekeyCatchUp, requiresFreshSecret, validateTrigger, MEMBERSHIP_EVENT_TO_TRIGGER } from "./key-management/rekey.js";

// Messaging + fan-out + delivery
export { createGroupMessage, groupMessageRef, ciphertextHash, newGroupMessageId } from "./messaging/groupMessage.js";
export { generateFanoutPlan, recomputeFanoutStatus, offlineLegs, validateFanoutPlan } from "./fanout/fanoutPlanner.js";
export { createLeg, transitionLeg, canLegTransition, assertLegTransition, DeliveryGuard, summarizeLegs, deliveryKey } from "./delivery/delivery.js";

// Synchronization + replicas
export { createGroupSyncPlan, remainingSyncOperations, advanceSyncCursor, validateSyncPlan, hashSyncPlan, FACET_SYNC_ORDER } from "./synchronization/groupSync.js";
export { buildCommReplica, applyReplicaUpdate, computeReplicaDelta, commReplicaFingerprint, normalizeFacetVersions, validateCommReplica } from "./replicas/groupCommReplica.js";

// Validators + serializers + dto
export * from "./validators/validators.js";
export { toKeyView, toMessageView, toFanoutView, toLegView, toReplicaView, toSyncPlanView, toDeliveryStatusView } from "./serializers/serializers.js";
export * from "./dto/dto.js";

// Repositories
export { createInMemoryGroupCommRepository } from "./repository/inMemoryGroupCommRepository.js";
export { createMongoGroupCommRepository } from "./repository/mongoGroupCommRepository.js";

// Engine + API
export { GroupCommunicationEngine, createGroupDirectoryFromManager } from "./manager/groupCommunicationEngine.js";
export { createGroupCommunicationApi } from "./api/groupCommunicationApi.js";

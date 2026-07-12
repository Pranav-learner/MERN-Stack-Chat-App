/**
 * @module group-communication/serializers
 *
 * Public DTOs for the Group Communication Engine. Whitelists PUBLIC fields for group keys, messages,
 * fan-out plans, delivery legs, replicas, and sync plans. Every view carries ids + versions + counts +
 * fingerprints ONLY — never ciphertext or key bytes. A message DTO exposes the ciphertext only when
 * explicitly requested (the device that will decrypt it), never in a list view.
 */

import { summarizeLegs } from "../delivery/delivery.js";

/** A group-key metadata DTO (no key bytes — fingerprint only). */
export function toKeyView(key) {
  if (!key) return null;
  return {
    groupId: key.groupId,
    keyVersion: key.keyVersion,
    keyId: key.keyId,
    fingerprint: key.fingerprint,
    algorithm: key.algorithm,
    state: key.state,
    trigger: key.trigger,
    createdBy: key.createdBy,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt ?? null,
    memberSetHash: key.memberSetHash,
    distribution: (key.distribution ?? []).map((d) => ({ memberId: d.memberId, delivered: !!d.delivered })),
    supersededBy: key.supersededBy ?? null,
  };
}

/** A compact group-message DTO (ciphertext only when `includeCiphertext`). */
export function toMessageView(message, { includeCiphertext = false } = {}) {
  if (!message) return null;
  const dto = {
    messageId: message.messageId,
    groupId: message.groupId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    keyVersion: message.keyVersion,
    contentHash: message.contentHash,
    priority: message.priority,
    metadata: message.metadata ?? {},
    createdAt: message.createdAt,
  };
  if (includeCiphertext) dto.ciphertext = message.ciphertext; // opaque
  return dto;
}

/** A fan-out plan DTO (leg summary + status; legs on request). */
export function toFanoutView(plan, { includeLegs = false } = {}) {
  if (!plan) return null;
  const dto = {
    planId: plan.planId,
    groupId: plan.groupId,
    messageId: plan.messageId,
    keyVersion: plan.keyVersion,
    status: plan.status,
    priority: plan.priority,
    onlineCount: plan.onlineCount,
    offlineCount: plan.offlineCount,
    truncated: !!plan.truncated,
    summary: plan.summary ?? summarizeLegs(plan.legs ?? []),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
  if (includeLegs) dto.legs = (plan.legs ?? []).map(toLegView);
  return dto;
}

/** A single delivery-leg DTO. */
export function toLegView(leg) {
  return { memberId: leg.memberId, deviceId: leg.deviceId, online: leg.online, priority: leg.priority, state: leg.state, attempts: leg.attempts, messageRef: leg.messageRef ?? null };
}

/** A comm-replica DTO. */
export function toReplicaView(replica) {
  if (!replica) return null;
  return {
    replicaId: replica.replicaId,
    groupId: replica.groupId,
    deviceId: replica.deviceId,
    memberId: replica.memberId,
    facetVersions: { ...(replica.facetVersions ?? {}) },
    keyVersion: replica.keyVersion,
    deliveryCursor: replica.deliveryCursor ?? null,
    pendingUpdates: replica.pendingUpdates ?? [],
    recovery: replica.recovery,
    diagnostics: replica.diagnostics,
    fingerprint: replica.fingerprint,
    updatedAt: replica.updatedAt,
  };
}

/** A sync-plan DTO. */
export function toSyncPlanView(plan) {
  if (!plan) return null;
  return {
    planId: plan.planId,
    groupId: plan.groupId,
    deviceId: plan.deviceId,
    operations: plan.operations,
    missedMessages: plan.missedMessages,
    totalOperations: plan.totalOperations,
    cursor: plan.cursor,
    upToDate: plan.upToDate,
    planHash: plan.planHash,
    createdAt: plan.createdAt,
  };
}

/** A delivery-status DTO for one message (per-leg roll-up). */
export function toDeliveryStatusView(plan) {
  if (!plan) return null;
  return { messageId: plan.messageId, groupId: plan.groupId, status: plan.status, summary: plan.summary ?? summarizeLegs(plan.legs ?? []), legs: (plan.legs ?? []).map(toLegView) };
}

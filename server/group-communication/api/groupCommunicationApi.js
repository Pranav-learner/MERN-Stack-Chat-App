/**
 * @module group-communication/api
 *
 * The stable **group communication service facade** the HTTP controller delegates to. Wraps the
 * {@link GroupCommunicationEngine} with a flat, DTO-normalizing surface: establish/rotate/list keys,
 * send/receive/list group messages, fan-out + delivery status + diagnostics, synchronize + replicas,
 * and offline resume + pending members.
 *
 * @security Every mutating op is member- + key-checked in the engine; reads return metadata + counts +
 * fingerprints only (no ciphertext unless a member explicitly requests a message body, no keys ever).
 */

import {
  normalizeSend,
  normalizeRotateKey,
  normalizeEstablishKey,
  normalizeSync,
  normalizeReconnect,
  normalizeDeliveryQuery,
} from "../dto/dto.js";

export function createGroupCommunicationApi(engine) {
  return {
    // keys + rekey
    establishGroupKey: (params) => engine.establishGroupKey(normalizeEstablishKey(params)),
    rotateGroupKey: (params) => engine.rotateGroupKey(normalizeRotateKey(params)),
    getKeyVersion: (params) => engine.getKeyVersion(params),
    listKeys: (params) => engine.listKeys(params),
    getKeyAudit: (params) => engine.getKeyAudit(params),
    sweepExpiredKeys: (params) => engine.sweepExpiredKeys(params),

    // messaging + fan-out
    sendGroupMessage: (params) => engine.sendGroupMessage(normalizeSend(params)),
    receiveGroupMessage: (params) => engine.receiveGroupMessage(params),
    getMessage: (params) => engine.getMessage(params),
    listMessages: (params) => engine.listMessages(params),
    getFanoutPlan: (params) => engine.getFanoutPlan(params),
    getDeliveryStatus: (params) => engine.getDeliveryStatus(normalizeDeliveryQuery(params)),
    fanoutDiagnostics: (params) => engine.fanoutDiagnostics(params),

    // offline support
    resumeDelivery: (params) => engine.resumeDelivery(normalizeReconnect(params)),
    getPendingMembers: (params) => engine.getPendingMembers(params),

    // synchronization + replicas
    registerReplica: (params) => engine.registerReplica(params),
    synchronizeGroup: (params) => engine.synchronizeGroup(normalizeSync(params)),
    getReplica: (params) => engine.getReplica(params),
    listReplicas: (params) => engine.listReplicas(params),

    health: () => engine.health(),
  };
}

/**
 * @module group-receipts/api
 *
 * The stable **group-receipt service facade** the HTTP controller delegates to. Wraps the
 * {@link GroupReceiptManager} with a flat, DTO-normalizing surface: register a message, track delivery/
 * read, and read the receipt status / readers / pending / offline members / delivery + read statistics /
 * analytics / diagnostics.
 *
 * @security Read endpoints return delivery control-plane metadata + counts + ticks only (no content/
 * keys). Delivery/read tracking is idempotent + deduplicated in the manager.
 */

import { normalizeRegister, normalizeDelivery, normalizeRead, normalizeQuery } from "../dto/dto.js";

export function createReceiptApi(manager) {
  return {
    // registration + tracking
    registerMessage: (params) => manager.registerMessage(normalizeRegister(params)),
    trackDelivery: (params) => manager.trackDelivery(normalizeDelivery(params)),
    trackRead: (params) => manager.trackRead(normalizeRead(params)),

    // receipt reads (O(1))
    getReceipt: ({ messageId }) => manager.getReceipt(messageId),
    getTick: ({ messageId }) => manager.getTick(messageId),
    getMemberReceipt: ({ messageId, memberId }) => manager.getMemberReceipt(messageId, memberId),

    // list reads
    getReaders: ({ messageId, limit, offset }) => manager.getReaders(messageId, { limit, offset }),
    getPendingMembers: ({ messageId, limit, offset }) => manager.getPendingMembers(messageId, { limit, offset }),
    getOfflineMembers: ({ messageId, limit }) => manager.getOfflineMembers(messageId, { limit }),

    // analytics + diagnostics
    getAnalytics: ({ messageId, computeOffline }) => manager.getAnalytics(messageId, { computeOffline }),
    getDeliveryStats: ({ messageId }) => manager.getDeliveryStats(messageId),
    getReadStats: ({ messageId }) => manager.getReadStats(messageId),
    getDiagnostics: ({ messageId }) => manager.getDiagnostics(messageId),
    listGroupReceipts: ({ groupId, limit }) => manager.listGroupReceipts(groupId, { limit }),
    health: () => manager.health(),
  };
}

export { normalizeQuery };

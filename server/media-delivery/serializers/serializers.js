/**
 * @module media-delivery/serializers
 *
 * Public DTOs for the Media Delivery subsystem. Whitelists PUBLIC fields for streaming sessions,
 * transfers, chunks, previews/thumbnails, sync plans, and diagnostics. Every view carries ids + states +
 * chunk indices + counts + sizes + hashes ONLY — never plaintext or keys. A chunk DTO carries the OPAQUE
 * ciphertext bytes (base64) + a per-chunk hash for device-side reassembly + verification.
 */

/** A streaming-session DTO. */
export function toSessionView(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    mediaId: session.mediaId,
    deviceId: session.deviceId,
    state: session.state,
    contentType: session.contentType ?? null,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    totalBytes: session.totalBytes,
    cursor: session.cursor,
    buffered: session.buffered,
    bufferWindow: session.bufferWindow ?? [],
    deliveredCount: session.deliveredCount ?? 0,
    seekCount: session.seekCount ?? 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/** A chunk DTO — OPAQUE ciphertext bytes (base64) + per-chunk hash for device reassembly. */
export function toChunkView(chunk) {
  return { index: chunk.index, offset: chunk.offset, length: chunk.length, hash: chunk.hash, last: !!chunk.last, data: Buffer.isBuffer(chunk.bytes) ? chunk.bytes.toString("base64") : chunk.data };
}

/** A transfer DTO. */
export function toTransferView(transfer) {
  if (!transfer) return null;
  return {
    transferId: transfer.transferId,
    mediaId: transfer.mediaId,
    direction: transfer.direction,
    deviceId: transfer.deviceId,
    state: transfer.state,
    priority: transfer.priority,
    chunkSize: transfer.chunkSize,
    chunkCount: transfer.chunkCount,
    deliveredChunks: transfer.deliveredChunks ?? 0,
    bytesTotal: transfer.bytesTotal,
    bytesTransferred: transfer.bytesTransferred ?? 0,
    window: transfer.window,
    progress: transfer.chunkCount ? Number(((transfer.deliveredChunks ?? 0) / transfer.chunkCount).toFixed(4)) : 0,
    received: transfer.received ?? [],
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
  };
}

/** A preview/thumbnail DTO. */
export function toPreviewView(preview) {
  if (!preview) return null;
  return { previewId: preview.previewId, mediaId: preview.mediaId, kind: preview.kind, state: preview.state, version: preview.version, metadata: preview.metadata ?? {}, updatedAt: preview.updatedAt };
}

/** A media-sync-plan DTO. */
export function toSyncPlanView(plan) {
  if (!plan) return null;
  return { planId: plan.planId, deviceId: plan.deviceId, operations: plan.operations, total: plan.total, cursor: plan.cursor, upToDate: plan.upToDate, planHash: plan.planHash };
}

/** An availability-replica DTO. */
export function toReplicaView(replica) {
  if (!replica) return null;
  return { deviceId: replica.deviceId, availableCount: replica.availableCount, available: replica.available, version: replica.version, fingerprint: replica.fingerprint, updatedAt: replica.updatedAt };
}

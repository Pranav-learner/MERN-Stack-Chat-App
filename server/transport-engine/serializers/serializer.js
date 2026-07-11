/**
 * @module transport-engine/serializers
 *
 * Public DTOs for the transport engine. Whitelists PUBLIC fields for a transfer + compact progress /
 * chunk-status views. A transfer DTO carries METADATA + progress only — never the chunk bytes. Chunk
 * DTOs carry position + state, never the opaque `data` (unless a receiver explicitly pulls it to
 * reassemble).
 *
 * @security No DTO carries plaintext. The payload bytes are excluded from transfer/chunk views by
 * default; even when a chunk's `data` is included (for a receiver pull) it is opaque ciphertext.
 */

import { TERMINAL_TRANSFER_STATES, TransferState } from "../types/types.js";

const TERMINAL = new Set(TERMINAL_TRANSFER_STATES);

/** Shape a transfer into its public DTO (progress + metadata; no chunk bytes). */
export function toPublicTransfer(t) {
  if (!t) return null;
  const total = t.payloadMeta?.totalChunks ?? 0;
  const done = t.direction === "inbound" ? (t.chunksReceived ?? 0) : (t.chunksAcked ?? 0);
  return {
    transferId: t.transferId,
    conversationId: t.conversationId,
    senderDeviceId: t.senderDeviceId,
    receiverDeviceId: t.receiverDeviceId,
    direction: t.direction,
    state: t.state,
    priority: t.priority,
    payloadMeta: sanitizeMeta(t.payloadMeta),
    progress: total > 0 ? done / total : t.state === TransferState.COMPLETED ? 1 : 0,
    chunksAcked: t.chunksAcked ?? 0,
    chunksReceived: t.chunksReceived ?? 0,
    bytesTransferred: t.bytesTransferred ?? 0,
    terminal: TERMINAL.has(t.state),
    completed: t.state === TransferState.COMPLETED,
    failureReason: t.failureReason ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    expiresAt: t.expiresAt,
    version: t.version,
    schemaVersion: t.schemaVersion,
  };
}

/** A compact transfer progress view (for polling). */
export function toProgress(t) {
  const total = t.payloadMeta?.totalChunks ?? 0;
  const done = t.direction === "inbound" ? (t.chunksReceived ?? 0) : (t.chunksAcked ?? 0);
  return {
    transferId: t.transferId,
    state: t.state,
    direction: t.direction,
    totalChunks: total,
    completedChunks: done,
    progress: total > 0 ? done / total : t.state === TransferState.COMPLETED ? 1 : 0,
    bytesTransferred: t.bytesTransferred ?? 0,
    totalSize: t.payloadMeta?.totalSize ?? 0,
    terminal: TERMINAL.has(t.state),
  };
}

/** A compact chunk-status view (never the opaque data unless requested). */
export function toChunkStatus(c, options = {}) {
  const dto = {
    chunkId: c.chunkId,
    transferId: c.transferId,
    index: c.index,
    total: c.total,
    size: c.size,
    state: c.state,
    retryCount: c.retryCount ?? 0,
    checksum: c.checksum,
  };
  if (options.includeData) dto.data = c.data; // OPAQUE ciphertext (receiver pull only)
  return dto;
}

/** A compact list item for active-transfer listings. */
export function toTransferListItem(t) {
  return {
    transferId: t.transferId,
    conversationId: t.conversationId,
    direction: t.direction,
    state: t.state,
    priority: t.priority,
    kind: t.payloadMeta?.kind,
    totalChunks: t.payloadMeta?.totalChunks ?? 0,
    progress: toProgress(t).progress,
  };
}

/** Strip any accidental non-public fields from payload metadata (keeps it opaque-safe). */
function sanitizeMeta(meta) {
  if (!meta) return meta;
  const { kind, name, mimeType, totalSize, totalChunks, chunkSize, checksum } = meta;
  return { kind, name, mimeType, totalSize, totalChunks, chunkSize, checksum };
}

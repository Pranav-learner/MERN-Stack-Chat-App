/**
 * @module media-delivery/progressive
 *
 * **Progressive transfers** — the model + pure logic for chunked download/upload of encrypted media with
 * a bounded TRANSFER WINDOW (max chunks in flight), partial fetch/upload, and RECOVERY metadata (which
 * chunks are already received, so a resume re-fetches only the gaps). A progressive DOWNLOAD reads
 * ciphertext chunks from the {@link module:media-delivery/manager/mediaGateway gateway}; a progressive
 * UPLOAD accepts ciphertext chunks and assembles them, handing the whole to the Sprint-1 pipeline on
 * completion.
 *
 * @security A transfer record carries ids + states + chunk indices + byte counts ONLY — never ciphertext
 * bytes (those flow chunk-by-chunk and are not retained in the record) or keys. Integrity is preserved:
 * each chunk carries a per-chunk hash. Pure functions — every mutation returns a NEW record.
 */

import crypto from "node:crypto";
import { TransferState, TRANSFER_TRANSITIONS, ALL_TRANSFER_STATES, TransferDirection, TransferPriority, MEDIA_DELIVERY_SCHEMA_VERSION, DEFAULT_CHUNK_SIZE, DEFAULT_TRANSFER_WINDOW } from "../types/types.js";
import { InvalidTransitionError } from "../errors.js";

/** Whether a transfer transition is legal (self-transition allowed). */
export function canTransferTransition(from, to) {
  if (from === to) return true;
  return (TRANSFER_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transfer transition is legal. @throws {InvalidTransitionError} */
export function assertTransferTransition(from, to) {
  if (!ALL_TRANSFER_STATES.includes(to)) throw new InvalidTransitionError(`Unknown transfer state "${to}"`, { details: { from, to } });
  if (!canTransferTransition(from, to)) throw new InvalidTransitionError(`Cannot transition transfer from "${from}" to "${to}"`, { details: { from, to, allowed: TRANSFER_TRANSITIONS[from] ?? [] } });
}

/**
 * Build a progressive transfer record. @param {object} params
 * @param {string} params.mediaId @param {string} params.direction @param {string} params.deviceId
 * @param {number} params.bytesTotal @param {number} [params.chunkSize] @param {number} [params.window]
 * @param {string} [params.priority] @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 */
export function createTransfer(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const chunkSize = params.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const bytesTotal = params.bytesTotal ?? 0;
  return {
    transferId: params.transferId ?? idGenerator(),
    mediaId: String(params.mediaId),
    direction: params.direction ?? TransferDirection.DOWNLOAD,
    deviceId: String(params.deviceId),
    ownerId: String(params.ownerId ?? params.deviceId),
    contentType: params.contentType ?? null,
    state: TransferState.PENDING,
    priority: params.priority ?? TransferPriority.NORMAL,
    chunkSize,
    chunkCount: Math.max(1, Math.ceil(bytesTotal / chunkSize)),
    bytesTotal,
    bytesTransferred: 0,
    deliveredChunks: 0,
    received: [], // received chunk indices (recovery metadata)
    window: params.window ?? DEFAULT_TRANSFER_WINDOW,
    metadata: params.metadata ?? {},
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 1,
    schemaVersion: MEDIA_DELIVERY_SCHEMA_VERSION,
  };
}

/** Transition a transfer (validated). Returns a NEW record. */
export function transitionTransfer(transfer, toState, patch = {}, at = new Date().toISOString()) {
  assertTransferTransition(transfer.state, toState);
  return { ...transfer, ...patch, state: toState, version: (transfer.version ?? 1) + 1, updatedAt: at };
}

/**
 * Record a received chunk (idempotent — a duplicate chunk doesn't double-count). Returns a NEW record +
 * whether it was newly received. Pure.
 */
export function receiveChunk(transfer, { index, length }, at = new Date().toISOString()) {
  const received = new Set(transfer.received ?? []);
  const isNew = !received.has(index);
  if (isNew) received.add(index);
  const receivedArr = [...received].sort((a, b) => a - b);
  const bytesTransferred = isNew ? (transfer.bytesTransferred ?? 0) + (length ?? 0) : transfer.bytesTransferred ?? 0;
  return {
    transfer: {
      ...transfer,
      received: receivedArr,
      deliveredChunks: receivedArr.length,
      bytesTransferred: Math.min(bytesTransferred, transfer.bytesTotal || bytesTransferred),
      version: (transfer.version ?? 1) + 1,
      updatedAt: at,
    },
    isNew,
    complete: receivedArr.length >= transfer.chunkCount,
  };
}

/** The chunk indices still missing (recovery / resume — the gaps). */
export function missingChunks(transfer) {
  const received = new Set(transfer.received ?? []);
  const out = [];
  for (let i = 0; i < transfer.chunkCount; i++) if (!received.has(i)) out.push(i);
  return out;
}

/** The next window of chunk indices to fetch (bounded by the transfer window). */
export function nextWindow(transfer) {
  return missingChunks(transfer).slice(0, transfer.window ?? DEFAULT_TRANSFER_WINDOW);
}

/** Progress in `[0,1]`. */
export function transferProgress(transfer) {
  if (!transfer.chunkCount) return 0;
  return Number(((transfer.deliveredChunks ?? 0) / transfer.chunkCount).toFixed(4));
}

export { TransferState, TransferDirection };

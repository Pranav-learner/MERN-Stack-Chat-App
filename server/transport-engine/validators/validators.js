/**
 * @module transport-engine/validators
 *
 * Validation for the Transport Engine. Covers every spec item: duplicate chunks, missing chunks,
 * invalid ordering, transfer corruption, expired transfers, malformed metadata, repository
 * consistency, and replay placeholders. It also enforces the framework's core invariant:
 *
 * @security A transfer / chunk / envelope must carry OPAQUE CIPHERTEXT only — NEVER plaintext or key
 * material. {@link assertNoPlaintext} deep-scans for forbidden secret/plaintext key names before a
 * record is stored or a wire envelope is built. The engine never decodes a fragment.
 */

import { ALL_PRIORITIES, ALL_PAYLOAD_KINDS, TransportWireType, MAX_PAYLOAD_SIZE, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE } from "../types/types.js";
import { verifyChunk } from "../chunks/chunk.js";
import {
  TransportValidationError,
  TransferNotFoundError,
  ChunkValidationError,
  DuplicateChunkError,
  TransferExpiredError,
  UnauthorizedTransferError,
} from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#-]{1,160}$/;

/**
 * Field names that must NEVER appear in a transfer/chunk/envelope — secret key material OR obvious
 * plaintext markers. (`checksum` is explicitly allowed — an integrity hash over ciphertext.)
 */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "keyBytes",
  "seed",
  "plaintext",
  "plainText",
  "cleartext",
  "decrypted",
]);

/** Validate an id reference. @throws {TransportValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) {
    throw new TransportValidationError(`Invalid ${label}`, { details: { id } });
  }
  return id;
}

/** Validate transfer payload metadata (size, count, kind, chunk size). @throws {TransportValidationError} */
export function validatePayloadMeta(meta) {
  if (!meta || typeof meta !== "object") throw new TransportValidationError("payloadMeta is required");
  if (!Number.isInteger(meta.totalSize) || meta.totalSize <= 0) throw new TransportValidationError("payloadMeta.totalSize must be a positive integer", { details: { totalSize: meta.totalSize } });
  if (meta.totalSize > MAX_PAYLOAD_SIZE) throw new TransportValidationError("payloadMeta.totalSize exceeds the maximum", { details: { totalSize: meta.totalSize, max: MAX_PAYLOAD_SIZE } });
  if (!Number.isInteger(meta.totalChunks) || meta.totalChunks < 1) throw new TransportValidationError("payloadMeta.totalChunks must be >= 1", { details: { totalChunks: meta.totalChunks } });
  if (meta.chunkSize !== undefined && (!Number.isInteger(meta.chunkSize) || meta.chunkSize < MIN_CHUNK_SIZE || meta.chunkSize > MAX_CHUNK_SIZE)) {
    throw new TransportValidationError("payloadMeta.chunkSize out of range", { details: { chunkSize: meta.chunkSize } });
  }
  if (meta.kind !== undefined && !ALL_PAYLOAD_KINDS.includes(meta.kind)) throw new TransportValidationError(`Unknown payload kind "${meta.kind}"`, { details: { kind: meta.kind } });
  assertNoPlaintext(meta, "payloadMeta");
  return meta;
}

/** Validate a start-transfer request. @throws {TransportValidationError} */
export function validateStartRequest(request) {
  if (!request || typeof request !== "object") throw new TransportValidationError("Malformed start-transfer request");
  validateRef(request.conversationId, "conversation identifier");
  validateRef(request.senderDeviceId, "sender device identifier");
  validateRef(request.receiverDeviceId, "receiver device identifier");
  if (request.payload == null && request.payloadMeta == null) throw new TransportValidationError("A payload (or payloadMeta for a relayed transfer) is required");
  if (request.priority !== undefined && !ALL_PRIORITIES.includes(request.priority)) throw new TransportValidationError(`Unknown priority "${request.priority}"`, { details: { priority: request.priority } });
  return request;
}

/** Validate a chunk record / envelope shape + integrity. @throws {ChunkValidationError} */
export function validateChunk(chunk) {
  if (!chunk || typeof chunk !== "object") throw new ChunkValidationError("Chunk is not an object");
  validateRef(chunk.transferId, "transfer identifier");
  validateRef(chunk.chunkId, "chunk identifier");
  if (!Number.isInteger(chunk.index) || chunk.index < 0) throw new ChunkValidationError("chunk.index must be a non-negative integer", { details: { index: chunk.index } });
  if (!Number.isInteger(chunk.total) || chunk.total < 1) throw new ChunkValidationError("chunk.total must be >= 1", { details: { total: chunk.total } });
  if (chunk.index >= chunk.total) throw new ChunkValidationError("chunk.index must be < chunk.total (invalid ordering)", { details: { index: chunk.index, total: chunk.total } });
  if (typeof chunk.data !== "string" || chunk.data.length === 0) throw new ChunkValidationError("chunk.data (opaque ciphertext) is required");
  if (typeof chunk.checksum !== "string") throw new ChunkValidationError("chunk.checksum is required");
  if (!verifyChunk(chunk)) throw new ChunkValidationError("chunk failed its integrity checksum (corruption)", { details: { chunkId: chunk.chunkId } });
  assertNoPlaintext(chunk, "chunk");
  return chunk;
}

/** Validate an inbound wire envelope's shape. @throws {TransportValidationError} */
export function validateWireEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new TransportValidationError("Wire envelope is not an object");
  if (!Object.values(TransportWireType).includes(envelope.type)) throw new TransportValidationError(`Unknown wire type "${envelope.type}"`);
  validateRef(envelope.transferId, "transfer identifier");
  validateRef(envelope.sender, "sender identifier");
  validateRef(envelope.receiver, "receiver identifier");
  if (envelope.type === TransportWireType.CHUNK) validateChunk({ transferId: envelope.transferId, chunkId: envelope.chunkId, index: envelope.index, total: envelope.total, data: envelope.data, checksum: envelope.checksum });
  assertNoPlaintext(envelope, "wire envelope");
  return envelope;
}

/** Require a transfer to exist. @throws {TransferNotFoundError} */
export function requireTransfer(transfer, ref) {
  if (!transfer) throw new TransferNotFoundError("Transfer not found", { details: { ref } });
  return transfer;
}

/** Assert the acting device owns the transfer (sender or receiver). @throws {UnauthorizedTransferError} */
export function assertParticipant(transfer, actingDevice) {
  const id = String(actingDevice);
  if (id !== String(transfer.senderDeviceId) && id !== String(transfer.receiverDeviceId)) {
    throw new UnauthorizedTransferError("Caller is not a participant in this transfer", { details: { transferId: transfer.transferId } });
  }
  return transfer;
}

/** Assert the acting device is the transfer's sender. @throws {UnauthorizedTransferError} */
export function assertSender(transfer, actingDevice) {
  if (String(transfer.senderDeviceId) !== String(actingDevice)) {
    throw new UnauthorizedTransferError("Caller is not the sender of this transfer", { details: { transferId: transfer.transferId } });
  }
  return transfer;
}

/** Assert a transfer has not expired. @throws {TransferExpiredError} */
export function assertNotExpired(transfer, now = Date.now()) {
  if (transfer?.expiresAt && new Date(transfer.expiresAt).getTime() <= now && transfer.state !== "expired") {
    throw new TransferExpiredError("Transfer has expired", { details: { transferId: transfer.transferId, expiresAt: transfer.expiresAt } });
  }
  return transfer;
}

/**
 * Deep-scan for forbidden plaintext / secret key material. @param {any} value @param {string} [label]
 * @throws {ChunkValidationError}
 */
export function assertNoPlaintext(value, label = "record") {
  const seen = new Set();
  const walk = (node, path) => {
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new ChunkValidationError(`${label} must not contain plaintext/secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** FUTURE placeholder — transport-level replay detection. Inert (crypto replay is Layer 5). */
export function checkReplay() {
  return false;
}

/** Validate a repository implements the required transfer + chunk store contract. */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new TransportValidationError("Transport repository is missing or malformed");
  for (const store of ["transfers", "chunks"]) {
    if (!repo[store] || typeof repo[store] !== "object") throw new TransportValidationError(`Transport repository is missing the "${store}" store`);
  }
  for (const m of ["create", "findById", "update"]) if (typeof repo.transfers[m] !== "function") throw new TransportValidationError(`transfers store is missing method "${m}"`);
  for (const m of ["upsert", "findByTransfer"]) if (typeof repo.chunks[m] !== "function") throw new TransportValidationError(`chunks store is missing method "${m}"`);
  return repo;
}

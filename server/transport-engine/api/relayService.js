/**
 * @module transport-engine/api/relay
 *
 * The server-side **blind chunk relay** for large-payload transport. Where the {@link TransportEngine}
 * runs on a DEVICE (peer-to-peer — fragmentation, flow control, reassembly), the relay runs on the
 * SERVER: a sender opens a transfer + relays its opaque ciphertext chunks; the receiver pulls the
 * chunks (store-and-forward) and acknowledges them; both read progress. It reuses the transport
 * repository + validators + serializers.
 *
 * @security The relay is BLIND — it stores + forwards ciphertext fragments, verifies only their
 * INTEGRITY checksums (over ciphertext, not keys), and never decrypts or reassembles plaintext. It
 * returns metadata DTOs (opaque chunk data only on an explicit receiver pull). Ownership is enforced:
 * only the sender relays; only the receiver pulls + ACKs.
 */

import {
  validateStartRequest,
  validatePayloadMeta,
  validateChunk,
  validateRef,
  requireTransfer,
  assertSender,
  assertParticipant,
  assertNoPlaintext,
} from "../validators/validators.js";
import { toPublicTransfer, toProgress, toChunkStatus, toTransferListItem } from "../serializers/serializer.js";
import { TransportEventBus } from "../events/events.js";
import { assertTransferTransition } from "../lifecycle/lifecycle.js";
import {
  TransferState,
  TransferDirection,
  ChunkState,
  TransportEventType,
  TransferPriority,
  TransferFailureReason,
  DEFAULT_TRANSFER_TTL_MS,
  isActiveTransferState,
} from "../types/types.js";
import { TransportEngineError, UnauthorizedTransferError } from "../errors.js";

export class TransportRelayService {
  constructor(deps) {
    if (!deps?.repository) throw new Error("TransportRelayService requires { repository }");
    this.transfers = deps.repository.transfers;
    this.chunks = deps.repository.chunks;
    this.progressStore = deps.repository.progress ?? null;
    this.events = deps.events ?? new TransportEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? undefined;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TRANSFER_TTL_MS;
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /** A sender opens a transfer (registers the payload metadata; no bytes yet). @returns {Promise<object>} DTO */
  async openTransfer({ actingDevice, conversationId, receiverDeviceId, payloadMeta, priority }) {
    validateRef(actingDevice, "sender device identifier");
    validateStartRequest({ conversationId, senderDeviceId: actingDevice, receiverDeviceId, payloadMeta, priority });
    const meta = validatePayloadMeta(payloadMeta);
    const transferId = (this.idGenerator ?? (() => `${conversationId}-${this.clock()}`))();
    const now = this.clock();
    const transfer = {
      transferId,
      conversationId: String(conversationId),
      senderDeviceId: String(actingDevice),
      receiverDeviceId: String(receiverDeviceId),
      direction: TransferDirection.OUTBOUND,
      state: TransferState.ACTIVE,
      priority: priority ?? TransferPriority.FILE,
      payloadMeta: meta,
      chunksAcked: 0,
      chunksReceived: 0,
      bytesTransferred: 0,
      stream: { streamed: false, reserved: true },
      auditMetadata: { createdAt: this._nowIso(), relay: true },
      failureReason: null,
      createdAt: this._nowIso(),
      updatedAt: this._nowIso(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      version: 1,
      schemaVersion: 1,
    };
    assertNoPlaintext(transfer, "transfer");
    const stored = await this.transfers.create(transfer);
    this.events.emit(TransportEventType.TRANSFER_STARTED, { transferId, conversationId: transfer.conversationId, direction: TransferDirection.OUTBOUND, relay: true });
    return toPublicTransfer(stored);
  }

  /** The sender relays one opaque chunk. Verifies integrity, stores it, advances progress. */
  async relayChunk({ actingDevice, transferId, chunk }) {
    const transfer = await this._require(transferId);
    assertSender(transfer, actingDevice);
    if (!isActiveTransferState(transfer.state)) throw new TransportEngineError(`Cannot relay to a ${transfer.state} transfer`, { code: "ERR_TRANSPORT_INVALID_TRANSITION", status: 409 });
    const record = { ...chunk, transferId: String(transferId), conversationId: transfer.conversationId };
    validateChunk(record); // integrity + no-plaintext
    const existing = await this.chunks.findById(record.chunkId);
    await this.chunks.upsert({ ...record, state: ChunkState.RECEIVED, retryCount: 0, nextRetryAt: null });
    if (!existing) {
      const received = (transfer.chunksReceived ?? 0) + 1;
      const bytes = (transfer.bytesTransferred ?? 0) + record.size;
      await this.transfers.update(transferId, { chunksReceived: received, bytesTransferred: bytes });
      this.events.emit(TransportEventType.CHUNK_RECEIVED, { transferId, chunkId: record.chunkId, index: record.index, relay: true });
    }
    return toChunkStatus(record);
  }

  /** The receiver pulls stored chunks (with opaque data) it has not yet pulled/acked. */
  async pullChunks({ actingDevice, transferId, limit }) {
    const transfer = await this._require(transferId);
    if (String(transfer.receiverDeviceId) !== String(actingDevice)) throw new UnauthorizedTransferError("Only the receiver can pull chunks", { details: { transferId } });
    const stored = await this.chunks.findByTransfer(String(transferId), { states: [ChunkState.RECEIVED] });
    const slice = limit ? stored.slice(0, limit) : stored;
    return {
      payloadMeta: transfer.payloadMeta,
      chunks: slice.map((c) => toChunkStatus(c, { includeData: true })),
    };
  }

  /** The receiver acknowledges chunks it has durably received. Completes the transfer when all are ACKed. */
  async ackChunks({ actingDevice, transferId, chunkIds }) {
    const transfer = await this._require(transferId);
    if (String(transfer.receiverDeviceId) !== String(actingDevice)) throw new UnauthorizedTransferError("Only the receiver can acknowledge chunks", { details: { transferId } });
    let acked = 0;
    for (const chunkId of chunkIds ?? []) {
      const chunk = await this.chunks.findById(chunkId);
      if (!chunk || chunk.transferId !== String(transferId) || chunk.state === ChunkState.ACKED) continue;
      await this.chunks.update(chunkId, { state: ChunkState.ACKED });
      acked++;
    }
    const total = transfer.payloadMeta.totalChunks;
    const counts = await this.chunks.countByState(String(transferId));
    const ackedTotal = counts[ChunkState.ACKED] ?? 0;
    let updated = await this.transfers.update(transferId, { chunksAcked: ackedTotal });
    if (ackedTotal >= total && !isTerminal(updated.state)) {
      updated = await this._transition(updated, TransferState.COMPLETED);
      this.events.emit(TransportEventType.TRANSFER_COMPLETED, { transferId, conversationId: transfer.conversationId, relay: true });
    }
    return { acked, progress: toProgress(updated) };
  }

  /** Pause / resume / cancel (metadata-level; the device engine enforces the actual flow). */
  async pauseTransfer({ actingDevice, transferId }) {
    return this._setState(transferId, actingDevice, TransferState.PAUSED, TransportEventType.TRANSFER_PAUSED);
  }
  async resumeTransfer({ actingDevice, transferId }) {
    return this._setState(transferId, actingDevice, TransferState.ACTIVE, TransportEventType.TRANSFER_RESUMED);
  }
  async cancelTransfer({ actingDevice, transferId }) {
    return this._setState(transferId, actingDevice, TransferState.CANCELLED, TransportEventType.TRANSFER_CANCELLED, TransferFailureReason.CANCELLED);
  }

  /** A transfer's progress. */
  async getProgress({ actingDevice, transferId }) {
    const transfer = await this._require(transferId);
    if (actingDevice) assertParticipant(transfer, actingDevice);
    return toProgress(transfer);
  }

  /** A transfer's public DTO. */
  async getTransfer({ actingDevice, transferId }) {
    const transfer = await this._require(transferId);
    if (actingDevice) assertParticipant(transfer, actingDevice);
    return toPublicTransfer(transfer);
  }

  /** Chunk statuses (metadata only). */
  async getChunkStatus({ transferId }) {
    validateRef(transferId, "transfer identifier");
    return (await this.chunks.findByTransfer(String(transferId))).map((c) => toChunkStatus(c));
  }

  /** A device's active transfers. */
  async listActiveTransfers({ actingDevice, conversationId }) {
    const list = await this.transfers.listActive(actingDevice);
    const filtered = conversationId ? list.filter((t) => t.conversationId === String(conversationId)) : list;
    return filtered.map(toTransferListItem);
  }

  /** Aggregate transfer diagnostics for a conversation. */
  async getDiagnostics({ conversationId }) {
    validateRef(conversationId, "conversation identifier");
    const all = await this.transfers.listByConversation(String(conversationId));
    const byState = {};
    for (const t of all) byState[t.state] = (byState[t.state] ?? 0) + 1;
    return { conversationId: String(conversationId), total: all.length, byState, role: "relay", canDecrypt: false };
  }

  // --- internals ----------------------------------------------------------

  async _setState(transferId, actingDevice, toState, event, failureReason) {
    const transfer = await this._require(transferId);
    assertParticipant(transfer, actingDevice);
    if (isTerminal(transfer.state)) throw new TransportEngineError(`Transfer is already ${transfer.state}`, { code: "ERR_TRANSPORT_INVALID_TRANSITION", status: 409 });
    const updated = await this._transition(transfer, toState, failureReason ? { failureReason } : undefined);
    this.events.emit(event, { transferId, by: String(actingDevice), relay: true });
    return toPublicTransfer(updated);
  }

  async _transition(transfer, toState, patch = {}) {
    assertTransferTransition(transfer.state, toState);
    return this.transfers.update(transfer.transferId, { state: toState, version: (transfer.version ?? 0) + 1, updatedAt: this._nowIso(), ...patch });
  }

  async _require(transferId) {
    validateRef(transferId, "transfer identifier");
    return requireTransfer(await this.transfers.findById(String(transferId)), transferId);
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

export function createTransportRelayService(deps) {
  return new TransportRelayService(deps);
}

function isTerminal(state) {
  return [TransferState.COMPLETED, TransferState.FAILED, TransferState.CANCELLED, TransferState.EXPIRED, TransferState.DESTROYED].includes(state);
}

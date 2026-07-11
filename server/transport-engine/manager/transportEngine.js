/**
 * @module transport-engine/manager
 *
 * The **Transport Engine** — the reusable facade for Layer 8, Sprint 2. It efficiently transports
 * LARGE, already-encrypted payloads (files, images, videos, voice notes, documents, binary) across the
 * Active Connections Layer 7 established: it fragments a payload into chunks, schedules their
 * transmission under a per-transfer sliding window with backpressure, multiplexes many concurrent
 * transfers with fair priority scheduling, and reassembles + integrity-validates the payload on the
 * receiver. One engine per device; it both SENDS and RECEIVES over an INJECTED transport.
 *
 * @important Transports OPAQUE ciphertext ONLY. A payload arrives ALREADY ENCRYPTED; the engine slices
 * the ciphertext, never decrypts it, and never stores plaintext or keys. It does NOT implement voice
 * calls, video calls, live streaming, or media codecs (Layer 11) — the `stream` seam is inert.
 *
 * @distributed Per-chunk reliability (ACK, retransmission) is delegated to a reliable transport; this
 * engine adds the TRANSFER-level concerns: fragmentation, flow control, backpressure, multiplexing,
 * priority scheduling, reassembly, and completion. The design mirrors a windowed transport protocol at
 * the application layer — without replacing transport-level congestion control.
 *
 * @example
 * ```js
 * const engine = new TransportEngine({ deviceId: "d1", ...createInMemoryTransportRepository(), transport });
 * engine.onPayload(({ payload, payloadMeta }) => decryptAndSave(payload, payloadMeta)); // receiver
 * const { transfer } = await engine.startTransfer({ conversationId: "c1", receiverDeviceId: "d2", payload: ciphertext, payloadMeta: { kind: "image", name: "cat.jpg" } });
 * engine.onEvent("transport.transfer_progress", (e) => updateBar(e.transferId, e.progress));
 * ```
 */

import crypto from "node:crypto";
import {
  TransferState,
  ChunkState,
  TransferDirection,
  TransportWireType,
  ChunkAckKind,
  TransferControl,
  TransportEventType,
  TransferFailureReason,
  TransferPriority,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_CONCURRENT_TRANSFERS,
  DEFAULT_CHUNK_ACK_TIMEOUT_MS,
  DEFAULT_MAX_CHUNK_RETRIES,
  DEFAULT_TRANSFER_TTL_MS,
  DEFAULT_RECEIVER_WINDOW,
  DEFAULT_MAX_BUFFERED_BYTES,
} from "../types/types.js";
import { TransportEngineError, TransferNotFoundError } from "../errors.js";
import { assertTransferTransition } from "../lifecycle/lifecycle.js";
import { fragmentPayload } from "../fragmentation/fragmenter.js";
import { Reassembler } from "../reassembly/reassembler.js";
import { FlowController } from "../flow-control/flowController.js";
import { ReceiverBackpressure, SenderResourceGuard } from "../buffering/backpressure.js";
import { Multiplexer } from "../multiplexing/multiplexer.js";
import { TransferScheduler } from "../scheduler/scheduler.js";
import { buildChunkEnvelope, buildChunkAckEnvelope, buildControlEnvelope } from "../transport/wire.js";
import { TransportEventBus } from "../events/events.js";
import {
  validateStartRequest,
  validatePayloadMeta,
  validateWireEnvelope,
  validateRepository,
  validateRef,
  requireTransfer,
  assertParticipant,
  assertSender,
  assertNoPlaintext,
} from "../validators/validators.js";
import { toPublicTransfer, toProgress, toChunkStatus, toTransferListItem } from "../serializers/serializer.js";

/** Absolute cap on chunks sent in a single pump (loop backstop). */
const PUMP_HARD_CAP = 100_000;

export class TransportEngine {
  /**
   * @param {object} deps
   * @param {string} deps.deviceId this device's id
   * @param {object} deps.transfers transfer store (required) @param {object} deps.chunks chunk store (required)
   * @param {object} [deps.progress] @param {object} [deps.history] @param {object} [deps.audit]
   * @param {{ send: (envelope: object) => Promise<void> }} deps.transport injected transport (required)
   * @param {TransportEventBus} [deps.events] @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {object} [deps.options] `{ windowSize, chunkSize, maxConcurrent, chunkAckTimeoutMs, maxChunkRetries, ttlMs, receiverWindow, maxBufferedBytes, agingMs }`
   */
  constructor(deps) {
    if (!deps?.deviceId) throw new Error("TransportEngine requires { deviceId }");
    validateRepository({ transfers: deps.transfers, chunks: deps.chunks });
    if (!deps.transport || typeof deps.transport.send !== "function") throw new Error("TransportEngine requires a transport with send()");
    this.deviceId = String(deps.deviceId);
    this.transfers = deps.transfers;
    this.chunks = deps.chunks;
    this.progressStore = deps.progress ?? null;
    this.historyStore = deps.history ?? null;
    this.auditStore = deps.audit ?? null;
    this.transport = deps.transport;
    this.events = deps.events ?? new TransportEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    const o = deps.options ?? {};
    this.windowSize = o.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.chunkSize = o.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkAckTimeoutMs = o.chunkAckTimeoutMs ?? DEFAULT_CHUNK_ACK_TIMEOUT_MS;
    this.maxChunkRetries = o.maxChunkRetries ?? DEFAULT_MAX_CHUNK_RETRIES;
    this.ttlMs = o.ttlMs ?? DEFAULT_TRANSFER_TTL_MS;
    this.receiverWindow = o.receiverWindow ?? DEFAULT_RECEIVER_WINDOW;
    this.maxBufferedBytes = o.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

    this.multiplexer = new Multiplexer({ maxConcurrent: o.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TRANSFERS });
    this.scheduler = new TransferScheduler({ agingMs: o.agingMs });
    this.senderGuard = new SenderResourceGuard({ maxQueueDepth: o.maxQueueDepth, maxInFlightBytes: o.maxInFlightBytes });

    /** @type {Map<string, object>} outbound transfer contexts */
    this._outbound = new Map();
    /** @type {Map<string, object>} inbound transfer contexts */
    this._inbound = new Map();
    /** @type {Set<Function>} reassembled-payload handlers (opaque ciphertext to the app) */
    this._payloadHandlers = new Set();
  }

  /** Subscribe to a transport event (or `"*"`). @returns {() => void} */
  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /**
   * Register the APPLICATION payload handler — invoked with each fully-reassembled inbound payload's
   * OPAQUE ciphertext + metadata so the app can decrypt + persist it. This is the ONLY channel that
   * carries payload bytes. @returns {() => void}
   */
  onPayload(handler) {
    this._payloadHandlers.add(handler);
    return () => this._payloadHandlers.delete(handler);
  }

  // === outbound ============================================================

  /**
   * Start an outbound transfer: fragment the encrypted payload, persist the chunks, and begin
   * transmitting under flow control. @returns {Promise<{ transfer: object }>}
   *
   * @param {{ conversationId: string, receiverDeviceId: string, payload: Buffer|Uint8Array|string, payloadMeta?: object, priority?: string, chunkSize?: number, ttlMs?: number }} request
   */
  async startTransfer(request) {
    const req = { ...request, senderDeviceId: this.deviceId };
    validateStartRequest(req);
    if (request.payloadMeta) assertNoPlaintext(request.payloadMeta, "payloadMeta"); // reject smuggled plaintext/keys
    const transferId = request.transferId ?? this.idGenerator();
    const priority = request.priority ?? defaultPriorityFor(request.payloadMeta?.kind);
    const chunkSize = request.chunkSize ?? this.chunkSize;

    // Fragment the opaque ciphertext.
    const frag = fragmentPayload(request.payload, { transferId, conversationId: request.conversationId, chunkSize, priority });
    const payloadMeta = validatePayloadMeta({
      kind: request.payloadMeta?.kind,
      name: request.payloadMeta?.name,
      mimeType: request.payloadMeta?.mimeType,
      totalSize: frag.totalSize,
      totalChunks: frag.totalChunks,
      chunkSize: frag.chunkSize,
      checksum: frag.checksum,
    });

    const now = this.clock();
    const transfer = {
      transferId,
      conversationId: String(request.conversationId),
      senderDeviceId: this.deviceId,
      receiverDeviceId: String(request.receiverDeviceId),
      direction: TransferDirection.OUTBOUND,
      state: TransferState.CREATED,
      priority,
      payloadMeta,
      chunksAcked: 0,
      chunksReceived: 0,
      bytesTransferred: 0,
      stream: { streamed: false, reserved: true }, // FUTURE media seam (Layer 11)
      auditMetadata: { createdAt: this._nowIso() },
      failureReason: null,
      createdAt: this._nowIso(),
      updatedAt: this._nowIso(),
      expiresAt: new Date(now + (request.ttlMs ?? this.ttlMs)).toISOString(),
      version: 1,
      schemaVersion: 1,
    };
    assertNoPlaintext(transfer, "transfer");
    let stored = await this.transfers.create(transfer);
    stored = await this._transitionTransfer(stored, TransferState.FRAGMENTING);
    this.events.emit(TransportEventType.TRANSFER_STARTED, { transferId, conversationId: transfer.conversationId, direction: TransferDirection.OUTBOUND, totalChunks: frag.totalChunks, totalSize: frag.totalSize, priority });

    // Persist chunks (PENDING).
    for (const chunk of frag.chunks) {
      chunk.createdAt = this._nowIso();
      assertNoPlaintext({ checksum: chunk.checksum }, "chunk-meta"); // data is opaque ciphertext
      await this.chunks.upsert(chunk);
    }
    this.events.emit(TransportEventType.TRANSFER_FRAGMENTED, { transferId, totalChunks: frag.totalChunks });
    stored = await this._transitionTransfer(stored, TransferState.ACTIVE);

    // Register the outbound context + stream.
    const ctx = {
      transfer: stored,
      flow: new FlowController({ windowSize: this.windowSize, receiverWindow: this.receiverWindow }),
      pending: frag.chunks.slice(), // ordered PENDING chunks
      sent: new Map(),
      ackedCount: 0,
      totalChunks: frag.totalChunks,
      readySince: new Map(frag.chunks.map((c) => [c.chunkId, now])),
      paused: false,
    };
    this._outbound.set(transferId, ctx);
    this.multiplexer.register(transferId, { conversationId: transfer.conversationId, priority, direction: TransferDirection.OUTBOUND, registeredAt: this._nowIso() });

    await this.pump();
    return { transfer: toPublicTransfer(ctx.transfer) };
  }

  /**
   * Send as many chunks as flow control + resource limits + fair scheduling permit. Idempotent + safe
   * to call repeatedly (after acks, on a timer, on resume). @returns {Promise<{ sent: number }>}
   */
  async pump() {
    let sent = 0;
    const blocked = new Set(); // transfers whose transport send failed this pump
    for (;;) {
      if (sent >= PUMP_HARD_CAP) break;
      const now = this.clock();
      const order = this.multiplexer.rotation();
      const candidates = [];
      for (const tid of order) {
        if (blocked.has(tid)) continue;
        const ctx = this._outbound.get(tid);
        if (!ctx || ctx.paused || ctx.transfer.state !== TransferState.ACTIVE) continue;
        if (ctx.pending.length === 0 || !ctx.flow.canSend()) continue;
        if (!this.senderGuard.admit(ctx.sent.size, ctx.pending[0].size)) continue;
        const chunk = ctx.pending[0];
        candidates.push({ transferId: tid, chunkId: chunk.chunkId, index: chunk.index, priority: ctx.transfer.priority, readySince: ctx.readySince.get(chunk.chunkId) ?? now });
      }
      if (candidates.length === 0) break;
      const chosen = this.scheduler.pick(candidates, now);
      const ctx = this._outbound.get(chosen.transferId);
      const chunk = ctx.pending.shift();
      const ok = await this._sendChunk(ctx, chunk);
      if (ok) sent++;
      else {
        ctx.pending.unshift(chunk); // send failed → requeue + skip this transfer this pump
        blocked.add(chosen.transferId);
      }
    }
    return { sent };
  }

  /** @private Transmit a single chunk (occupying a window slot). @returns {boolean} success */
  async _sendChunk(ctx, chunk) {
    const now = this.clock();
    chunk.state = ChunkState.SENT;
    chunk.nextRetryAt = new Date(now + this.chunkAckTimeoutMs).toISOString();
    ctx.sent.set(chunk.chunkId, chunk);
    ctx.flow.onSent(chunk.chunkId);
    this.senderGuard.reserve(chunk.size);
    const envelope = buildChunkEnvelope(chunk, { sender: this.deviceId, receiver: ctx.transfer.receiverDeviceId }, { payloadMeta: ctx.transfer.payloadMeta, ts: this._nowIso() });
    try {
      await this.transport.send(envelope);
      await this.chunks.update(chunk.chunkId, { state: ChunkState.SENT, nextRetryAt: chunk.nextRetryAt, retryCount: chunk.retryCount ?? 0 });
      this.events.emit(TransportEventType.CHUNK_SENT, { transferId: ctx.transfer.transferId, chunkId: chunk.chunkId, index: chunk.index, retry: chunk.retryCount ?? 0 });
      return true;
    } catch {
      // No live connection → revert this chunk to PENDING; a later pump / sweep retries it.
      ctx.flow.onAcked(chunk.chunkId);
      ctx.sent.delete(chunk.chunkId);
      this.senderGuard.release(chunk.size);
      chunk.state = ChunkState.PENDING;
      chunk.nextRetryAt = null;
      return false;
    }
  }

  // === inbound / receiving =================================================

  /** Receive a wire envelope (chunk / chunk-ack / control) from the transport. */
  async receive(envelope) {
    validateWireEnvelope(envelope);
    if (envelope.type === TransportWireType.CHUNK) return this._handleChunk(envelope);
    if (envelope.type === TransportWireType.CHUNK_ACK) return this._handleChunkAck(envelope);
    if (envelope.type === TransportWireType.CONTROL) return this._handleControl(envelope);
    return { outcome: "ignored" };
  }

  /** @private Handle an inbound CHUNK: validate → reassemble → ACK → maybe complete. */
  async _handleChunk(envelope) {
    let ctx = this._inbound.get(envelope.transferId);
    if (!ctx) {
      if (!envelope.payloadMeta) return { outcome: "invalid", reason: "missing-payload-meta" };
      const meta = validatePayloadMeta(envelope.payloadMeta);
      const transfer = await this._createInboundTransfer(envelope, meta);
      ctx = {
        transfer,
        reassembler: new Reassembler({ transferId: envelope.transferId, totalChunks: meta.totalChunks, totalSize: meta.totalSize, checksum: meta.checksum }),
        backpressure: new ReceiverBackpressure({ maxBufferedBytes: this.maxBufferedBytes, receiverWindow: this.receiverWindow }),
      };
      this._inbound.set(envelope.transferId, ctx);
      this.multiplexer.register(envelope.transferId, { conversationId: transfer.conversationId, priority: transfer.priority, direction: TransferDirection.INBOUND, registeredAt: this._nowIso() });
      this.events.emit(TransportEventType.TRANSFER_STARTED, { transferId: envelope.transferId, conversationId: transfer.conversationId, direction: TransferDirection.INBOUND, totalChunks: meta.totalChunks, totalSize: meta.totalSize });
    }

    const chunk = { transferId: envelope.transferId, chunkId: envelope.chunkId, conversationId: envelope.conversationId, index: envelope.index, total: envelope.total, offset: envelope.offset, size: envelope.size, data: envelope.data, checksum: envelope.checksum, priority: envelope.priority };
    const res = ctx.reassembler.accept(chunk);

    if (res.outcome === "invalid") {
      this.events.emit(TransportEventType.CHUNK_FAILED, { transferId: envelope.transferId, chunkId: envelope.chunkId, reason: res.reason });
      return { outcome: "invalid", reason: res.reason }; // no ACK → sender retransmits
    }
    if (res.outcome === "duplicate") {
      await this._sendChunkAck(ctx, [envelope.chunkId], ChunkAckKind.DUPLICATE);
      return { outcome: "duplicate" };
    }

    // Accepted → store + account.
    await this.chunks.upsert({ ...chunk, state: ChunkState.RECEIVED, retryCount: 0, nextRetryAt: null });
    const engaged = ctx.backpressure.onBuffered(chunk.size);
    ctx.transfer.chunksReceived = res.received;
    ctx.transfer.bytesTransferred = (ctx.transfer.bytesTransferred ?? 0) + chunk.size;
    ctx.transfer = await this.transfers.update(envelope.transferId, { chunksReceived: res.received, bytesTransferred: ctx.transfer.bytesTransferred, state: TransferState.REASSEMBLING });
    this.events.emit(TransportEventType.CHUNK_RECEIVED, { transferId: envelope.transferId, chunkId: envelope.chunkId, index: envelope.index, received: res.received, total: ctx.reassembler.totalChunks });
    if (engaged) this.events.emit(TransportEventType.BACKPRESSURE_APPLIED, { transferId: envelope.transferId, bufferedBytes: ctx.backpressure.bufferedBytes });
    this._emitProgress(ctx.transfer, res.received);

    await this._sendChunkAck(ctx, [envelope.chunkId], ChunkAckKind.ACK);

    if (res.complete) {
      const reconstructed = ctx.reassembler.reconstruct(); // throws on corruption / missing
      const released = ctx.backpressure.onDrained(reconstructed.totalSize);
      for (const handler of this._payloadHandlers) {
        try {
          handler({ transferId: envelope.transferId, conversationId: ctx.transfer.conversationId, sender: envelope.sender, payloadMeta: ctx.transfer.payloadMeta, payload: reconstructed.payload, checksum: reconstructed.checksum });
        } catch {
          /* an app handler throwing must not break completion */
        }
      }
      if (released) this.events.emit(TransportEventType.BACKPRESSURE_RELEASED, { transferId: envelope.transferId });
      await this._completeTransfer(ctx.transfer, TransferDirection.INBOUND);
      this._inbound.delete(envelope.transferId);
      return { outcome: "completed" };
    }
    return { outcome: "accepted", received: res.received };
  }

  /** @private Handle an inbound CHUNK-ACK: advance the window, mark chunks acked, maybe complete. */
  async _handleChunkAck(envelope) {
    const ctx = this._outbound.get(envelope.transferId);
    if (!ctx) return { outcome: "ignored" };
    if (envelope.receiverWindow != null) {
      const prev = ctx.flow.receiverWindow;
      ctx.flow.setReceiverWindow(envelope.receiverWindow);
      if (envelope.receiverWindow !== prev) this.events.emit(TransportEventType.WINDOW_UPDATED, { transferId: envelope.transferId, receiverWindow: envelope.receiverWindow });
    }
    let acked = 0;
    for (const chunkId of envelope.chunkIds ?? []) {
      const chunk = ctx.sent.get(chunkId);
      if (!chunk) continue; // already acked / unknown
      ctx.sent.delete(chunkId);
      ctx.flow.onAcked(chunkId);
      this.senderGuard.release(chunk.size);
      chunk.state = ChunkState.ACKED;
      ctx.ackedCount++;
      ctx.transfer.bytesTransferred = (ctx.transfer.bytesTransferred ?? 0) + chunk.size;
      await this.chunks.update(chunkId, { state: ChunkState.ACKED, nextRetryAt: null });
      this.events.emit(TransportEventType.CHUNK_ACKED, { transferId: envelope.transferId, chunkId, index: chunk.index, acked: ctx.ackedCount, total: ctx.totalChunks });
      acked++;
    }
    if (acked > 0) {
      ctx.transfer.chunksAcked = ctx.ackedCount;
      ctx.transfer = await this.transfers.update(envelope.transferId, { chunksAcked: ctx.ackedCount, bytesTransferred: ctx.transfer.bytesTransferred });
      this._emitProgress(ctx.transfer, ctx.ackedCount);
    }
    if (ctx.ackedCount >= ctx.totalChunks) {
      await this._completeTransfer(ctx.transfer, TransferDirection.OUTBOUND);
      this._outbound.delete(envelope.transferId);
    } else {
      await this.pump();
    }
    return { outcome: "acked", acked };
  }

  /** @private Handle an inbound CONTROL envelope (peer pause / resume / cancel). */
  async _handleControl(envelope) {
    const ctx = this._outbound.get(envelope.transferId) ?? this._inbound.get(envelope.transferId);
    if (!ctx) return { outcome: "ignored" };
    switch (envelope.control) {
      case TransferControl.PAUSE:
        if (this._outbound.has(envelope.transferId)) await this._pauseOutbound(envelope.transferId, "peer");
        return { outcome: "paused" };
      case TransferControl.RESUME:
        if (this._outbound.has(envelope.transferId)) await this._resumeOutbound(envelope.transferId, "peer");
        return { outcome: "resumed" };
      case TransferControl.CANCEL:
        await this._cancelTransfer(envelope.transferId, "peer");
        return { outcome: "cancelled" };
      default:
        return { outcome: "ignored" };
    }
  }

  /** @private Build + send a chunk-ACK advertising the current receiver window. */
  async _sendChunkAck(ctx, chunkIds, ackKind) {
    const envelope = buildChunkAckEnvelope({
      transferId: ctx.transfer.transferId,
      conversationId: ctx.transfer.conversationId,
      sender: this.deviceId,
      receiver: ctx.transfer.senderDeviceId,
      ackKind,
      chunkIds,
      receiverWindow: ctx.backpressure.advertisedWindow(),
      ts: this._nowIso(),
    });
    try {
      await this.transport.send(envelope);
    } catch {
      /* ack couldn't be sent (link down) — the sender will retransmit + we re-ACK the duplicate */
    }
  }

  // === retransmission + expiry =============================================

  /**
   * Sweep: retransmit chunks past their ACK deadline (up to maxChunkRetries; then FAIL the transfer),
   * and expire transfers past their TTL. @param {number} [now] @returns {Promise<{ retried: number, failed: number, expired: number }>}
   */
  async sweepTimeouts(now = this.clock()) {
    let retried = 0;
    let failed = 0;
    let expired = 0;
    const nowIso = new Date(now).toISOString();

    for (const [transferId, ctx] of [...this._outbound.entries()]) {
      if (ctx.transfer.state !== TransferState.ACTIVE) continue;
      for (const chunk of [...ctx.sent.values()]) {
        if (!chunk.nextRetryAt || new Date(chunk.nextRetryAt).getTime() > now) continue;
        if ((chunk.retryCount ?? 0) >= this.maxChunkRetries) {
          chunk.state = ChunkState.FAILED;
          await this.chunks.update(chunk.chunkId, { state: ChunkState.FAILED });
          this.events.emit(TransportEventType.CHUNK_FAILED, { transferId, chunkId: chunk.chunkId, reason: TransferFailureReason.RETRY_EXHAUSTED });
          await this._failTransfer(ctx.transfer, TransferFailureReason.RETRY_EXHAUSTED);
          this._outbound.delete(transferId);
          failed++;
          break; // transfer is dead; stop sweeping its chunks
        }
        chunk.retryCount = (chunk.retryCount ?? 0) + 1;
        chunk.nextRetryAt = new Date(now + this.chunkAckTimeoutMs).toISOString();
        const envelope = buildChunkEnvelope(chunk, { sender: this.deviceId, receiver: ctx.transfer.receiverDeviceId }, { payloadMeta: ctx.transfer.payloadMeta, ts: nowIso });
        try {
          await this.transport.send(envelope);
          await this.chunks.update(chunk.chunkId, { retryCount: chunk.retryCount, nextRetryAt: chunk.nextRetryAt });
          this.events.emit(TransportEventType.CHUNK_RETRIED, { transferId, chunkId: chunk.chunkId, retryCount: chunk.retryCount });
          retried++;
        } catch {
          /* still no connection — try again next sweep */
        }
      }
    }

    // Expire stale transfers (both directions).
    for (const [transferId, ctx] of [...this._outbound.entries(), ...this._inbound.entries()]) {
      if (ctx.transfer.expiresAt && new Date(ctx.transfer.expiresAt).getTime() <= now && !isTerminal(ctx.transfer.state)) {
        await this._expireTransfer(ctx.transfer);
        this._outbound.delete(transferId);
        this._inbound.delete(transferId);
        expired++;
      }
    }
    return { retried, failed, expired };
  }

  // === control (local) =====================================================

  /** Pause an outbound transfer (stops scheduling its chunks + signals the peer). */
  async pauseTransfer(transferId, options = {}) {
    const transfer = await this._require(transferId);
    if (options.actingDevice) assertParticipant(transfer, options.actingDevice);
    await this._pauseOutbound(transferId, options.actingDevice ?? "local");
    return toPublicTransfer(await this._require(transferId));
  }

  /** Resume a paused outbound transfer. */
  async resumeTransfer(transferId, options = {}) {
    const transfer = await this._require(transferId);
    if (options.actingDevice) assertParticipant(transfer, options.actingDevice);
    await this._resumeOutbound(transferId, options.actingDevice ?? "local");
    return toPublicTransfer(await this._require(transferId));
  }

  /** Cancel a transfer (either direction). */
  async cancelTransfer(transferId, options = {}) {
    const transfer = await this._require(transferId);
    if (options.actingDevice) assertParticipant(transfer, options.actingDevice);
    await this._cancelTransfer(transferId, options.actingDevice ?? "local");
    return toPublicTransfer(await this._require(transferId));
  }

  /** @private */
  async _pauseOutbound(transferId, by) {
    const ctx = this._outbound.get(transferId);
    if (!ctx || ctx.paused || ctx.transfer.state !== TransferState.ACTIVE) return;
    ctx.paused = true;
    ctx.flow.pause();
    ctx.transfer = await this._transitionTransfer(ctx.transfer, TransferState.PAUSED, { reason: `paused-by-${by}` });
    this.events.emit(TransportEventType.TRANSFER_PAUSED, { transferId, by });
  }

  /** @private */
  async _resumeOutbound(transferId, by) {
    const ctx = this._outbound.get(transferId);
    if (!ctx || !ctx.paused) return;
    ctx.paused = false;
    ctx.flow.resume();
    ctx.transfer = await this._transitionTransfer(ctx.transfer, TransferState.ACTIVE, { reason: `resumed-by-${by}` });
    this.events.emit(TransportEventType.TRANSFER_RESUMED, { transferId, by });
    await this.pump();
  }

  /** @private */
  async _cancelTransfer(transferId, by) {
    const ctx = this._outbound.get(transferId) ?? this._inbound.get(transferId);
    if (!ctx || isTerminal(ctx.transfer.state)) return;
    ctx.transfer = await this._transitionTransfer(ctx.transfer, TransferState.CANCELLED, { reason: `cancelled-by-${by}`, patch: { failureReason: TransferFailureReason.CANCELLED } });
    this.events.emit(TransportEventType.TRANSFER_CANCELLED, { transferId, by });
    this._cleanup(transferId);
    if (this._outbound.has(transferId) && by === "local") {
      // best-effort tell the peer
      await this.transport.send(buildControlEnvelope({ transferId, conversationId: ctx.transfer.conversationId, sender: this.deviceId, receiver: ctx.transfer.receiverDeviceId, control: TransferControl.CANCEL, ts: this._nowIso() })).catch(() => {});
    }
    this._outbound.delete(transferId);
    this._inbound.delete(transferId);
  }

  // === queries =============================================================

  /** A transfer's public DTO. */
  async getTransfer(transferId, options = {}) {
    const transfer = await this._require(transferId);
    if (options.actingDevice) assertParticipant(transfer, options.actingDevice);
    return toPublicTransfer(transfer);
  }

  /** A transfer's compact progress. */
  async getProgress(transferId) {
    return toProgress(await this._require(transferId));
  }

  /** A transfer's chunk statuses (never the opaque data). */
  async getChunkStatus(transferId, options = {}) {
    validateRef(transferId, "transfer identifier");
    const chunks = await this.chunks.findByTransfer(String(transferId), { states: options.states });
    return chunks.map((c) => toChunkStatus(c));
  }

  /** Active transfers for this device (optionally filtered by conversation). */
  async listActiveTransfers(options = {}) {
    const list = await this.transfers.listActive(options.deviceId ?? this.deviceId);
    const filtered = options.conversationId ? list.filter((t) => t.conversationId === String(options.conversationId)) : list;
    return filtered.map(toTransferListItem);
  }

  /** Diagnostics for a transfer (flow + reassembly + chunk counts). */
  async getDiagnostics(transferId) {
    const transfer = await this._require(transferId);
    const out = this._outbound.get(String(transferId));
    const inb = this._inbound.get(String(transferId));
    return {
      transferId: transfer.transferId,
      state: transfer.state,
      direction: transfer.direction,
      progress: toProgress(transfer),
      flow: out ? out.flow.snapshot() : null,
      backpressure: inb ? inb.backpressure.snapshot() : null,
      reassembly: inb ? inb.reassembler.snapshot() : null,
      chunkCounts: await this.chunks.countByState(String(transferId)),
      pending: out ? out.pending.length : 0,
      outstanding: out ? out.sent.size : 0,
    };
  }

  /** Engine-wide diagnostics (multiplexing + resource usage). */
  diagnostics() {
    return {
      deviceId: this.deviceId,
      multiplexing: this.multiplexer.snapshot(),
      outbound: this._outbound.size,
      inbound: this._inbound.size,
      senderResources: this.senderGuard.snapshot(),
    };
  }

  // === internals ==========================================================

  /** @private */
  async _createInboundTransfer(envelope, meta) {
    const now = this.clock();
    const transfer = {
      transferId: envelope.transferId,
      conversationId: String(envelope.conversationId),
      senderDeviceId: String(envelope.sender),
      receiverDeviceId: this.deviceId,
      direction: TransferDirection.INBOUND,
      state: TransferState.REASSEMBLING,
      priority: envelope.priority ?? TransferPriority.FILE,
      payloadMeta: meta,
      chunksAcked: 0,
      chunksReceived: 0,
      bytesTransferred: 0,
      stream: { streamed: false, reserved: true },
      auditMetadata: { createdAt: this._nowIso() },
      failureReason: null,
      createdAt: this._nowIso(),
      updatedAt: this._nowIso(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      version: 1,
      schemaVersion: 1,
    };
    assertNoPlaintext(transfer, "transfer");
    return this.transfers.create(transfer);
  }

  /** @private complete a transfer (success). */
  async _completeTransfer(transfer, direction) {
    const done = await this._transitionTransfer(transfer, TransferState.COMPLETED);
    this.events.emit(TransportEventType.TRANSFER_COMPLETED, { transferId: transfer.transferId, conversationId: transfer.conversationId, direction, totalChunks: transfer.payloadMeta?.totalChunks, totalSize: transfer.payloadMeta?.totalSize });
    if (this.historyStore) await this.historyStore.record({ transferId: transfer.transferId, conversationId: transfer.conversationId, state: TransferState.COMPLETED, at: this._nowIso(), detail: { direction } });
    if (this.progressStore) await this.progressStore.save(transfer.transferId, toProgress(done));
    this._cleanup(transfer.transferId);
    return done;
  }

  /** @private fail a transfer. */
  async _failTransfer(transfer, reason) {
    const failed = await this._transitionTransfer(transfer, TransferState.FAILED, { patch: { failureReason: reason }, reason });
    this.events.emit(TransportEventType.TRANSFER_FAILED, { transferId: transfer.transferId, conversationId: transfer.conversationId, reason });
    if (this.historyStore) await this.historyStore.record({ transferId: transfer.transferId, conversationId: transfer.conversationId, state: TransferState.FAILED, at: this._nowIso(), detail: { reason } });
    this._cleanup(transfer.transferId);
    return failed;
  }

  /** @private expire a transfer. */
  async _expireTransfer(transfer) {
    const expired = await this._transitionTransfer(transfer, TransferState.EXPIRED, { patch: { failureReason: TransferFailureReason.EXPIRED }, reason: "ttl" });
    this.events.emit(TransportEventType.TRANSFER_EXPIRED, { transferId: transfer.transferId, conversationId: transfer.conversationId });
    this._cleanup(transfer.transferId);
    return expired;
  }

  /** @private remove a transfer from the multiplexer stream registry. */
  _cleanup(transferId) {
    this.multiplexer.unregister(transferId);
  }

  /** @private emit a progress event. */
  _emitProgress(transfer, completedChunks) {
    const total = transfer.payloadMeta?.totalChunks ?? 0;
    this.events.emit(TransportEventType.TRANSFER_PROGRESS, { transferId: transfer.transferId, conversationId: transfer.conversationId, direction: transfer.direction, completedChunks, totalChunks: total, progress: total > 0 ? completedChunks / total : 0 });
  }

  /** @private require a transfer to exist (validated). */
  async _require(transferId) {
    validateRef(transferId, "transfer identifier");
    return requireTransfer(await this.transfers.findById(String(transferId)), transferId);
  }

  /** @private guarded transfer transition + persist + (no event unless caller emits). */
  async _transitionTransfer(transfer, toState, options = {}) {
    assertTransferTransition(transfer.state, toState);
    const patch = { state: toState, version: (transfer.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "transfer");
    return this.transfers.update(transfer.transferId, patch);
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Default scheduling priority from a payload kind. */
function defaultPriorityFor(kind) {
  switch (kind) {
    case "image":
      return TransferPriority.IMAGE;
    case "voice-note":
      return TransferPriority.VOICE_NOTE;
    case "document":
      return TransferPriority.DOCUMENT;
    case "video":
    case "file":
    case "binary":
      return TransferPriority.FILE;
    default:
      return TransferPriority.FILE;
  }
}

function isTerminal(state) {
  return [TransferState.COMPLETED, TransferState.FAILED, TransferState.CANCELLED, TransferState.EXPIRED, TransferState.DESTROYED].includes(state);
}

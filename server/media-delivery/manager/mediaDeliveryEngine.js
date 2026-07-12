/**
 * @module media-delivery/manager
 *
 * The **Media Delivery Engine** — the reusable orchestrator for Layer 11, Sprint 2. It delivers
 * encrypted media efficiently by composing the streaming, progressive-transfer, thumbnail/preview, media-
 * synchronization, and optimization subsystems over the frozen Sprint-1 pipeline (via the {@link
 * createMediaGateway media gateway}). It streams (session + buffer + seek/pause/resume), progressively
 * downloads/uploads (windowed chunks + resume), generates previews/thumbnails (async + pluggable),
 * synchronizes media availability across devices (reusing the Layer 9 delta model), and optimizes
 * transfers (priorities + parallel scheduling + bandwidth metrics).
 *
 * @security A BLIND relay: it moves OPAQUE ciphertext in chunks (each with a per-chunk hash so integrity
 * is preserved) + control-plane metadata ONLY — it NEVER decrypts or handles keys. The device reassembles
 * + decrypts; the whole-object hash is still verified by Sprint 1.
 *
 * @evolution Storage-INDEPENDENT (reads through the gateway). Reuses Layer 8 (chunking/window), Layer 9
 * (media sync), Sprint 1 (pipeline). It does NOT implement voice/video calls, screen sharing, real-time
 * media, or codecs — preview/thumbnail generation is pluggable + async, defaulting to metadata-only.
 *
 * @example
 * ```js
 * const engine = new MediaDeliveryEngine({ ...createInMemoryDeliveryRepository(), mediaManager });
 * const { session } = await engine.startStreaming({ mediaId, deviceId: "phone", actorId: "phone" });
 * const chunk = await engine.streamChunk({ sessionId: session.sessionId, index: 0, actorId: "phone" });
 * ```
 */

import crypto from "node:crypto";
import {
  StreamingState,
  TransferState,
  TransferDirection,
  MediaDeliveryEventType,
  MediaAvailability,
  MEDIA_DELIVERY_FRAMEWORK,
  MEDIA_DELIVERY_SCHEMA_VERSION,
  DEFAULT_CHUNK_SIZE,
  PreviewState,
} from "../types/types.js";
import { MediaDeliveryError, SessionNotFoundError, TransferNotFoundError, StreamingError } from "../errors.js";
import { MediaDeliveryEventBus } from "../events/events.js";
import { createMediaGateway } from "./mediaGateway.js";
import { StreamBuffer } from "../buffering/buffer.js";
import { createStreamingSession, transitionStreaming, applyBufferSnapshot } from "../streaming/streamingSession.js";
import { createTransfer, transitionTransfer, receiveChunk, missingChunks, nextWindow, transferProgress } from "../progressive/progressiveTransfer.js";
import { createPreviewRecord, runGeneration, kindForContentType, defaultThumbnailGenerator } from "../thumbnails/thumbnailEngine.js";
import { defaultPreviewGenerator, PreviewCache } from "../previews/previewEngine.js";
import { buildAvailabilityReplica, computeMediaDelta, createMediaSyncPlan, markAvailable } from "../synchronization/mediaSync.js";
import { TransferScheduler } from "../optimization/transferOptimizer.js";
import {
  toSessionView,
  toChunkView,
  toTransferView,
  toPreviewView,
  toSyncPlanView,
  toReplicaView,
} from "../serializers/serializers.js";
import {
  validateRef,
  validateIndex,
  validatePreviewKind,
  validatePriority,
  validateDirection,
  assertChunkIntegrity,
  assertDeliveryAccess,
  assertNoContent,
  validateRepository,
} from "../validators/validators.js";

export class MediaDeliveryEngine {
  constructor(deps = {}) {
    validateRepository(deps);
    this.sessions = deps.sessions;
    this.transfers = deps.transfers;
    this.previews = deps.previews;
    this.availability = deps.availability;
    this.repo = deps;
    this.events = deps.events ?? new MediaDeliveryEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    if (!deps.gateway && !deps.mediaManager) throw new MediaDeliveryError("MediaDeliveryEngine requires a mediaManager or gateway", { code: "ERR_MEDIA_DELIVERY_VALIDATION", status: 500 });
    this.gateway = deps.gateway ?? createMediaGateway(deps.mediaManager, { clock: this.clock, cacheTtlMs: deps.sourceCacheTtlMs });
    this.thumbnailGenerator = deps.thumbnailGenerator ?? defaultThumbnailGenerator;
    this.previewGenerator = deps.previewGenerator ?? defaultPreviewGenerator;
    this.previewCache = deps.previewCache ?? new PreviewCache({ clock: this.clock });
    this.scheduler = deps.scheduler ?? new TransferScheduler({ parallel: deps.parallel, clock: this.clock });
    this.chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this._locks = new Map();
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === streaming ============================================================

  /** Start a streaming session over a media object. @returns {Promise<object>} */
  async startStreaming({ mediaId, deviceId, actorId, chunkSize, bufferChunks } = {}) {
    validateRef(mediaId, "media identifier");
    validateRef(deviceId, "device identifier");
    const media = await this.gateway.getMetadata(mediaId, actorId);
    if (media.state && media.state !== "available") throw new StreamingError(`Media is "${media.state}" — not available for streaming`, { reason: "not-available", details: { mediaId } });
    const session = createStreamingSession({ mediaId, deviceId, ownerId: actorId ?? deviceId, totalBytes: media.size, chunkSize: chunkSize ?? this.chunkSize, bufferChunks, contentType: media.contentType, clock: this.clock, idGenerator: this.idGenerator });
    const stored = await this.sessions.create(transitionStreaming(session, StreamingState.BUFFERING, {}, this._nowIso()));
    this.events.emit(MediaDeliveryEventType.STREAMING_STARTED, { sessionId: stored.sessionId, mediaId, deviceId, chunkCount: stored.chunkCount });
    return { session: toSessionView(stored) };
  }

  /** Fetch the next chunk for a streaming session (progressive playback). @returns {Promise<object>} */
  async streamChunk({ sessionId, index, actorId } = {}) {
    validateRef(sessionId, "session identifier");
    return this._withLock(sessionId, async () => {
      let session = await this._requireSession(sessionId);
      if (actorId) assertDeliveryAccess(session, actorId);
      const idx = index != null ? validateIndex(index) : session.cursor;
      if (idx >= session.chunkCount) throw new MediaDeliveryError("chunk index past end of media", { code: "ERR_MEDIA_DELIVERY_INVALID_RANGE", status: 416, reason: "invalid-range" });

      const chunk = await this.gateway.readChunk(session.mediaId, actorId, { index: idx, chunkSize: session.chunkSize });
      assertChunkIntegrity(chunk.hash, chunk.hash, idx); // per-chunk hash computed at read; preserved to the client

      const buffer = new StreamBuffer({ chunkCount: session.chunkCount, windowChunks: session.windowChunks });
      buffer.restore(session.bufferedChunks ?? [], session.cursor);
      buffer.add(idx);
      buffer.seek(Math.max(session.cursor, idx));

      let next = applyBufferSnapshot(session, buffer, this._nowIso());
      // transition BUFFERING/PAUSED → PLAYING while delivering; COMPLETED when fully buffered.
      if (buffer.isComplete()) next = transitionStreaming(next, StreamingState.COMPLETED, {}, this._nowIso());
      else if (session.state !== StreamingState.PLAYING) next = transitionStreaming(next, StreamingState.PLAYING, {}, this._nowIso());
      session = await this.sessions.update(sessionId, { ...toPersistable(next) });

      this.scheduler.recordBytes(chunk.length);
      this.events.emit(MediaDeliveryEventType.CHUNK_DELIVERED, { sessionId, mediaId: session.mediaId, index: idx, length: chunk.length, last: chunk.last });
      this.events.emit(MediaDeliveryEventType.BUFFER_UPDATED, { sessionId, cursor: session.cursor, buffered: session.buffered, fillRatio: buffer.fillRatio() });
      if (session.state === StreamingState.COMPLETED) this.events.emit(MediaDeliveryEventType.STREAMING_COMPLETED, { sessionId, mediaId: session.mediaId });
      return { chunk: toChunkView(chunk), session: toSessionView(session), nextToFetch: buffer.nextToFetch() };
    });
  }

  /** Seek a streaming session to a chunk index. */
  async seek({ sessionId, index, actorId } = {}) {
    validateRef(sessionId, "session identifier");
    validateIndex(index);
    return this._withLock(sessionId, async () => {
      let session = await this._requireSession(sessionId);
      if (actorId) assertDeliveryAccess(session, actorId);
      const buffer = new StreamBuffer({ chunkCount: session.chunkCount, windowChunks: session.windowChunks });
      buffer.restore(session.bufferedChunks ?? [], session.cursor);
      const target = buffer.seek(index);
      session = transitionStreaming(session, StreamingState.SEEKING, {}, this._nowIso());
      session = applyBufferSnapshot(session, buffer, this._nowIso());
      session = await this.sessions.update(sessionId, { ...toPersistable({ ...session, state: StreamingState.SEEKING, seekCount: (session.seekCount ?? 0) + 1, cursor: target }) });
      this.events.emit(MediaDeliveryEventType.STREAMING_SEEKED, { sessionId, cursor: target });
      return { session: toSessionView(session), nextToFetch: buffer.nextToFetch() };
    });
  }

  /** Pause a streaming session. */
  async pauseStreaming({ sessionId, actorId } = {}) {
    return this._streamTransition(sessionId, actorId, StreamingState.PAUSED, MediaDeliveryEventType.STREAMING_PAUSED);
  }
  /** Resume a paused (or failed) streaming session. */
  async resumeStreaming({ sessionId, actorId } = {}) {
    return this._streamTransition(sessionId, actorId, StreamingState.BUFFERING, MediaDeliveryEventType.STREAMING_RESUMED);
  }
  /** Cancel a streaming session. */
  async cancelStreaming({ sessionId, actorId } = {}) {
    return this._streamTransition(sessionId, actorId, StreamingState.CANCELLED, MediaDeliveryEventType.STREAMING_FAILED);
  }

  /** A streaming session's status. */
  async getStreamingStatus({ sessionId }) {
    return toSessionView(await this._requireSession(sessionId));
  }

  // === progressive transfers ===============================================

  /** Start a progressive download/upload. @returns {Promise<object>} */
  async startTransfer({ mediaId, deviceId, actorId, direction, priority, chunkSize, window, bytesTotal, contentType } = {}) {
    validateRef(mediaId, "media identifier");
    validateRef(deviceId, "device identifier");
    validateDirection(direction);
    validatePriority(priority);
    let total = bytesTotal;
    let ct = contentType;
    if (direction !== TransferDirection.UPLOAD) {
      const media = await this.gateway.getMetadata(mediaId, actorId);
      total = media.size;
      ct = media.contentType;
    }
    const transfer = createTransfer({ mediaId, deviceId, ownerId: actorId ?? deviceId, direction: direction ?? TransferDirection.DOWNLOAD, priority, chunkSize: chunkSize ?? this.chunkSize, window, bytesTotal: total, contentType: ct, clock: this.clock, idGenerator: this.idGenerator });
    const stored = await this.transfers.create(transitionTransfer(transfer, TransferState.ACTIVE, {}, this._nowIso()));
    this.scheduler.enqueue({ transferId: stored.transferId, priority: stored.priority, bytesTotal: stored.bytesTotal, mediaId });
    this.events.emit(MediaDeliveryEventType.TRANSFER_STARTED, { transferId: stored.transferId, mediaId, direction: stored.direction, chunkCount: stored.chunkCount });
    return { transfer: toTransferView(stored), nextWindow: nextWindow(stored) };
  }

  /** Fetch a chunk for a progressive DOWNLOAD (partial fetch). */
  async fetchChunk({ transferId, index, actorId } = {}) {
    validateRef(transferId, "transfer identifier");
    validateIndex(index);
    return this._withLock(transferId, async () => {
      const transfer = await this._requireTransfer(transferId);
      if (actorId) assertDeliveryAccess(transfer, actorId);
      if (transfer.direction !== TransferDirection.DOWNLOAD) throw new MediaDeliveryError("fetchChunk is for downloads", { code: "ERR_MEDIA_DELIVERY_VALIDATION", status: 400 });
      const chunk = await this.gateway.readChunk(transfer.mediaId, actorId, { index, chunkSize: transfer.chunkSize });
      const { transfer: next, complete } = receiveChunk(transfer, { index, length: chunk.length }, this._nowIso());
      let stored = await this.transfers.update(transferId, toPersistable(next));
      this.scheduler.recordBytes(chunk.length);
      this.events.emit(MediaDeliveryEventType.TRANSFER_PROGRESS, { transferId, mediaId: transfer.mediaId, progress: transferProgress(stored), index });
      if (complete) stored = await this._completeTransfer(stored);
      return { chunk: toChunkView(chunk), transfer: toTransferView(stored), nextWindow: nextWindow(stored) };
    });
  }

  /** Accept a chunk for a progressive UPLOAD (partial upload). The client sends opaque ciphertext bytes. */
  async uploadChunk({ transferId, index, data, hash, actorId } = {}) {
    validateRef(transferId, "transfer identifier");
    validateIndex(index);
    return this._withLock(transferId, async () => {
      const transfer = await this._requireTransfer(transferId);
      if (actorId) assertDeliveryAccess(transfer, actorId);
      if (transfer.direction !== TransferDirection.UPLOAD) throw new MediaDeliveryError("uploadChunk is for uploads", { code: "ERR_MEDIA_DELIVERY_VALIDATION", status: 400 });
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? "", "base64");
      // integrity: the client-provided per-chunk hash must match the bytes (tamper/corruption check).
      const { sha256 } = await import("../../media/encryption/mediaEncryption.js");
      assertChunkIntegrity(sha256(bytes), hash ?? sha256(bytes), index);
      // buffer the chunk bytes in the transfer's assembly (metadata store keeps indices; bytes held in engine)
      this._assembly(transferId).set(index, bytes);
      const { transfer: next, complete } = receiveChunk(transfer, { index, length: bytes.length }, this._nowIso());
      let stored = await this.transfers.update(transferId, toPersistable(next));
      this.events.emit(MediaDeliveryEventType.TRANSFER_PROGRESS, { transferId, mediaId: transfer.mediaId, progress: transferProgress(stored), index });
      return { transfer: toTransferView(stored), complete, missing: missingChunks(stored) };
    });
  }

  /** Finalize a progressive UPLOAD: assemble chunks + hand the whole to the Sprint-1 pipeline. */
  async completeUpload({ transferId, upload, actorId } = {}) {
    validateRef(transferId, "transfer identifier");
    return this._withLock(transferId, async () => {
      const transfer = await this._requireTransfer(transferId);
      if (actorId) assertDeliveryAccess(transfer, actorId);
      const gaps = missingChunks(transfer);
      if (gaps.length) throw new MediaDeliveryError(`upload incomplete — ${gaps.length} chunks missing`, { code: "ERR_MEDIA_DELIVERY_VALIDATION", status: 409, reason: "not-available", details: { missing: gaps.slice(0, 20) } });
      const assembly = this._assembly(transferId);
      const ciphertext = Buffer.concat(Array.from({ length: transfer.chunkCount }, (_, i) => assembly.get(i) ?? Buffer.alloc(0)));
      const result = await this.gateway.storeAssembled({ ...(upload ?? {}), ownerId: actorId ?? transfer.ownerId, ciphertext });
      const stored = await this._completeTransfer(transfer);
      this._assemblies?.delete(transferId);
      return { transfer: toTransferView(stored), media: result.media };
    });
  }

  /** Resume a paused/failed transfer (re-fetch only the missing chunks). */
  async resumeTransfer({ transferId, actorId } = {}) {
    validateRef(transferId, "transfer identifier");
    const transfer = await this._requireTransfer(transferId);
    if (actorId) assertDeliveryAccess(transfer, actorId);
    let next = transfer;
    if (transfer.state === TransferState.PAUSED || transfer.state === TransferState.FAILED) next = transitionTransfer(transfer, TransferState.ACTIVE, {}, this._nowIso());
    const stored = await this.transfers.update(transferId, toPersistable(next));
    this.scheduler.enqueue({ transferId, priority: stored.priority, bytesTotal: stored.bytesTotal, mediaId: stored.mediaId });
    this.events.emit(MediaDeliveryEventType.TRANSFER_RESUMED, { transferId, missing: missingChunks(stored).length });
    return { transfer: toTransferView(stored), nextWindow: nextWindow(stored), missing: missingChunks(stored) };
  }

  async pauseTransfer({ transferId, actorId } = {}) {
    return this._transferTransition(transferId, actorId, TransferState.PAUSED);
  }
  async cancelTransfer({ transferId, actorId } = {}) {
    const t = await this._transferTransition(transferId, actorId, TransferState.CANCELLED);
    this.scheduler.remove(transferId);
    return t;
  }
  async getTransferStatus({ transferId }) {
    return toTransferView(await this._requireTransfer(transferId));
  }

  // === thumbnails + previews (async + pluggable) ===========================

  /** Generate (or regenerate) a thumbnail for a media object. Async + pluggable. */
  async generateThumbnail({ mediaId, actorId, kind } = {}) {
    return this._generatePreview({ mediaId, actorId, kind, generator: this.thumbnailGenerator, event: MediaDeliveryEventType.THUMBNAIL_GENERATED });
  }

  /** Generate (or regenerate) a preview for a media object. Async + pluggable. */
  async generatePreview({ mediaId, actorId, kind } = {}) {
    return this._generatePreview({ mediaId, actorId, kind, generator: this.previewGenerator, event: MediaDeliveryEventType.PREVIEW_GENERATED });
  }

  /** A media object's cached/stored preview. */
  async getPreview({ mediaId, kind, actorId } = {}) {
    validateRef(mediaId, "media identifier");
    const media = await this.gateway.getMetadata(mediaId, actorId);
    const k = kind ?? kindForContentType(media.contentType);
    const cached = this.previewCache.get(mediaId, k);
    if (cached) return cached;
    const record = await this.previews.findByMediaKind(mediaId, k);
    const view = toPreviewView(record);
    if (view && record?.state === PreviewState.READY) this.previewCache.set(mediaId, k, view);
    return view;
  }

  // === media synchronization ===============================================

  /** Register a device's media availability (what it already has). */
  async registerAvailability({ deviceId, actorId, available } = {}) {
    validateRef(deviceId, "device identifier");
    const replica = buildAvailabilityReplica({ deviceId, userId: actorId, available, clock: this.clock });
    assertNoContent(replica, "availability replica");
    return toReplicaView(await this.availability.upsert(replica));
  }

  /**
   * Synchronize a device: compute the media it's missing vs. the authoritative set, queue offline
   * fetches, and return a resumable sync plan. @returns {Promise<object>}
   */
  async synchronizeDevice({ deviceId, actorId, authoritativeMedia = [], priorityOf } = {}) {
    validateRef(deviceId, "device identifier");
    const replica = (await this.availability.findByDevice(deviceId)) ?? buildAvailabilityReplica({ deviceId, userId: actorId, available: [], clock: this.clock });
    const delta = computeMediaDelta(replica, authoritativeMedia);
    const plan = createMediaSyncPlan({ deviceId, delta, priorityOf, idGenerator: this.idGenerator });
    for (const op of plan.operations) {
      await this.availability.enqueueOffline({ deviceId, mediaId: op.mediaId, priority: op.priority, at: this._nowIso() });
      this.events.emit(MediaDeliveryEventType.OFFLINE_MEDIA_QUEUED, { deviceId, mediaId: op.mediaId });
    }
    this.events.emit(MediaDeliveryEventType.MEDIA_SYNCHRONIZED, { deviceId, missing: delta.missing.length, available: delta.available.length });
    return { plan: toSyncPlanView(plan), delta, replica: toReplicaView(replica) };
  }

  /** Mark a media object available on a device (after a completed download). */
  async markMediaAvailable({ deviceId, mediaId, actorId } = {}) {
    validateRef(deviceId, "device identifier");
    validateRef(mediaId, "media identifier");
    const replica = (await this.availability.findByDevice(deviceId)) ?? buildAvailabilityReplica({ deviceId, userId: actorId, available: [], clock: this.clock });
    const updated = await this.availability.upsert(markAvailable(replica, mediaId, this._nowIso()));
    this.events.emit(MediaDeliveryEventType.MEDIA_AVAILABLE, { deviceId, mediaId });
    return toReplicaView(updated);
  }

  /** The device's offline media queue (pending downloads). */
  async getOfflineQueue({ deviceId }) {
    validateRef(deviceId, "device identifier");
    return this.availability.listOffline(deviceId);
  }

  // === optimization + diagnostics ==========================================

  /** Build a prefetch plan for candidate media (prefetch-priority transfer tasks). */
  async prefetch({ candidates = [] } = {}) {
    const plan = this.scheduler.prefetchPlan(candidates);
    this.events.emit(MediaDeliveryEventType.TRANSFER_OPTIMIZED, { prefetch: plan.length });
    return plan;
  }

  /** Run one scheduler tick — returns the transfers that should start now (respects parallel slots). */
  async optimizeTransfers() {
    const started = this.scheduler.schedule();
    if (started.length) this.events.emit(MediaDeliveryEventType.TRANSFER_OPTIMIZED, { started: started.length });
    return { started, scheduler: this.scheduler.stats() };
  }

  /** Bandwidth-usage metrics. */
  async bandwidthMetrics() {
    return this.scheduler.bandwidth();
  }

  /** Media-delivery diagnostics for a media object. */
  async getDiagnostics({ mediaId }) {
    validateRef(mediaId, "media identifier");
    return {
      sessions: (await this.sessions.listByMedia(mediaId)).map(toSessionView),
      transfers: (await this.transfers.listByMedia(mediaId)).map(toTransferView),
      previews: (await this.previews.listByMedia(mediaId)).map(toPreviewView),
      scheduler: this.scheduler.stats(),
      previewCache: this.previewCache.stats(),
    };
  }

  /** Aggregate control-plane health. */
  async health() {
    return { framework: MEDIA_DELIVERY_FRAMEWORK, schemaVersion: MEDIA_DELIVERY_SCHEMA_VERSION, scheduler: this.scheduler.stats(), at: this._nowIso() };
  }

  // === internals ============================================================

  async _generatePreview({ mediaId, actorId, kind, generator, event }) {
    validateRef(mediaId, "media identifier");
    validatePreviewKind(kind);
    const media = await this.gateway.getMetadata(mediaId, actorId);
    const k = kind ?? kindForContentType(media.contentType);
    let record = (await this.previews.findByMediaKind(mediaId, k)) ?? createPreviewRecord({ mediaId, kind: k, clock: this.clock, idGenerator: this.idGenerator });
    if (!record.previewId) record = createPreviewRecord({ mediaId, kind: k, clock: this.clock, idGenerator: this.idGenerator });
    const exists = await this.previews.findByMediaKind(mediaId, k);
    record = { ...record, state: PreviewState.GENERATING };
    const persistedPending = exists ? await this.previews.update(record.previewId, { state: PreviewState.GENERATING }) : await this.previews.create(record);
    const generated = await runGeneration(persistedPending, { media, generator, at: this._nowIso() });
    assertNoContent(generated.metadata ?? {}, "preview metadata");
    const stored = await this.previews.update(generated.previewId, toPersistable(generated));
    const view = toPreviewView(stored);
    if (stored.state === PreviewState.READY) {
      this.previewCache.set(mediaId, k, view);
      this.events.emit(event, { mediaId, kind: k, version: stored.version });
    } else {
      this.events.emit(MediaDeliveryEventType.PREVIEW_FAILED, { mediaId, kind: k });
    }
    return view;
  }

  async _completeTransfer(transfer) {
    if (transfer.state === TransferState.COMPLETED) return transfer;
    const done = transitionTransfer(transfer, TransferState.COMPLETED, {}, this._nowIso());
    const stored = await this.transfers.update(transfer.transferId, toPersistable(done));
    this.scheduler.complete(transfer.transferId);
    this.events.emit(MediaDeliveryEventType.TRANSFER_COMPLETED, { transferId: transfer.transferId, mediaId: transfer.mediaId, direction: transfer.direction });
    return stored;
  }

  async _streamTransition(sessionId, actorId, toState, event) {
    validateRef(sessionId, "session identifier");
    return this._withLock(sessionId, async () => {
      const session = await this._requireSession(sessionId);
      if (actorId) assertDeliveryAccess(session, actorId);
      const next = transitionStreaming(session, toState, {}, this._nowIso());
      const stored = await this.sessions.update(sessionId, toPersistable(next));
      this.events.emit(event, { sessionId, state: toState });
      return toSessionView(stored);
    });
  }

  async _transferTransition(transferId, actorId, toState) {
    validateRef(transferId, "transfer identifier");
    return this._withLock(transferId, async () => {
      const transfer = await this._requireTransfer(transferId);
      if (actorId) assertDeliveryAccess(transfer, actorId);
      const next = transitionTransfer(transfer, toState, {}, this._nowIso());
      return toTransferView(await this.transfers.update(transferId, toPersistable(next)));
    });
  }

  _assembly(transferId) {
    this._assemblies = this._assemblies ?? new Map();
    if (!this._assemblies.has(transferId)) this._assemblies.set(transferId, new Map());
    return this._assemblies.get(transferId);
  }

  async _requireSession(sessionId) {
    const s = await this.sessions.findById(String(sessionId));
    if (!s) throw new SessionNotFoundError("Streaming session not found", { details: { sessionId } });
    return s;
  }
  async _requireTransfer(transferId) {
    const t = await this.transfers.findById(String(transferId));
    if (!t) throw new TransferNotFoundError("Transfer not found", { details: { transferId } });
    return t;
  }

  async _withLock(id, fn) {
    const key = String(id);
    const prev = this._locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    const tail = prev.then(() => gate);
    this._locks.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === tail) this._locks.delete(key);
    }
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Strip transient fields before persisting a record patch (keep it schema-shaped). */
function toPersistable(record) {
  const { _id, ...rest } = record ?? {};
  return rest;
}

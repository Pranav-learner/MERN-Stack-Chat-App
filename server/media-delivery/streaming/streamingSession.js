/**
 * @module media-delivery/streaming
 *
 * The **streaming session** model — pure helpers for the record + the validated FSM that governs a
 * progressive-playback session over one media object. A session divides the ciphertext into logical
 * chunks and tracks a playback cursor + a {@link StreamBuffer buffer window}, supporting seek / pause /
 * resume. The engine drives it; this module owns the record shape + transitions.
 *
 * @security A session record carries ids + states + chunk indices + counts ONLY — never ciphertext or
 * keys. Pure functions — every mutation returns a NEW record (immutable).
 *
 * @evolution Progressive BYTE delivery + buffering + seek over the OPAQUE ciphertext this sprint; the
 * device reassembles + decrypts (whole-object GCM). True per-chunk playback of encrypted media needs
 * chunked crypto (a future codec/real-time concern) — the session FSM + buffer are the stable seam.
 */

import crypto from "node:crypto";
import { StreamingState, STREAMING_TRANSITIONS, ALL_STREAMING_STATES, MEDIA_DELIVERY_SCHEMA_VERSION, DEFAULT_CHUNK_SIZE, DEFAULT_BUFFER_CHUNKS } from "../types/types.js";
import { InvalidTransitionError } from "../errors.js";

/** Whether a streaming transition is legal (self-transition allowed). */
export function canStreamTransition(from, to) {
  if (from === to) return true;
  return (STREAMING_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a streaming transition is legal. @throws {InvalidTransitionError} */
export function assertStreamTransition(from, to) {
  if (!ALL_STREAMING_STATES.includes(to)) throw new InvalidTransitionError(`Unknown streaming state "${to}"`, { details: { from, to } });
  if (!canStreamTransition(from, to)) throw new InvalidTransitionError(`Cannot transition streaming from "${from}" to "${to}"`, { details: { from, to, allowed: STREAMING_TRANSITIONS[from] ?? [] } });
}

/**
 * Build a streaming session record. @param {object} params
 * @param {string} params.mediaId @param {string} params.deviceId @param {string} params.ownerId
 * @param {number} params.totalBytes @param {number} [params.chunkSize] @param {number} [params.bufferChunks]
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 */
export function createStreamingSession(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const chunkSize = params.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const totalBytes = params.totalBytes ?? 0;
  return {
    sessionId: params.sessionId ?? idGenerator(),
    mediaId: String(params.mediaId),
    deviceId: String(params.deviceId),
    ownerId: String(params.ownerId ?? params.deviceId),
    contentType: params.contentType ?? null,
    state: StreamingState.IDLE,
    chunkSize,
    chunkCount: Math.max(1, Math.ceil(totalBytes / chunkSize)),
    totalBytes,
    cursor: 0,
    buffered: -1, // highest contiguous buffered index
    bufferedChunks: [], // persisted buffered indices
    bufferWindow: [],
    windowChunks: params.bufferChunks ?? DEFAULT_BUFFER_CHUNKS,
    deliveredCount: 0,
    seekCount: 0,
    metadata: params.metadata ?? {},
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 1,
    schemaVersion: MEDIA_DELIVERY_SCHEMA_VERSION,
  };
}

/** Transition a session to a new state (validated). Returns a NEW record. */
export function transitionStreaming(session, toState, patch = {}, at = new Date().toISOString()) {
  assertStreamTransition(session.state, toState);
  return { ...session, ...patch, state: toState, version: (session.version ?? 1) + 1, updatedAt: at };
}

/** Apply the buffer snapshot to a session record (persistable). Returns a NEW record. */
export function applyBufferSnapshot(session, buffer, at = new Date().toISOString()) {
  const snap = buffer.snapshot();
  return {
    ...session,
    cursor: snap.cursor,
    buffered: snap.contiguous,
    bufferWindow: snap.bufferWindow,
    bufferedChunks: [...buffer._buffered].sort((a, b) => a - b),
    deliveredCount: buffer._buffered.size,
    version: (session.version ?? 1) + 1,
    updatedAt: at,
  };
}

export { StreamingState };

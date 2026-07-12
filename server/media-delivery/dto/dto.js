/**
 * @module media-delivery/dto
 *
 * **Request DTOs + normalizers** for the Media Delivery subsystem. Normalizes loose HTTP/client input
 * into the exact parameter objects the engine expects. Pure functions, no I/O.
 */

const id = (v) => (v == null ? undefined : String(v));
const num = (v) => (v == null ? undefined : Number(v));

/** Normalize a start-streaming request. */
export function normalizeStartStreaming(input = {}) {
  return { mediaId: id(input.mediaId), deviceId: id(input.deviceId ?? input.actorId), actorId: id(input.actorId), chunkSize: num(input.chunkSize), bufferChunks: num(input.bufferChunks) };
}

/** Normalize a chunk-fetch request. */
export function normalizeChunk(input = {}) {
  return { sessionId: id(input.sessionId), transferId: id(input.transferId), index: num(input.index), actorId: id(input.actorId) };
}

/** Normalize a seek request. */
export function normalizeSeek(input = {}) {
  return { sessionId: id(input.sessionId), index: num(input.index), actorId: id(input.actorId) };
}

/** Normalize a progressive-transfer request. */
export function normalizeTransfer(input = {}) {
  return { mediaId: id(input.mediaId), deviceId: id(input.deviceId ?? input.actorId), actorId: id(input.actorId), direction: input.direction, priority: input.priority, chunkSize: num(input.chunkSize), window: num(input.window), bytesTotal: num(input.bytesTotal), contentType: input.contentType };
}

/** Normalize a preview/thumbnail generation request. */
export function normalizePreview(input = {}) {
  return { mediaId: id(input.mediaId), kind: input.kind, actorId: id(input.actorId), options: input.options };
}

/** Normalize a device-sync request. */
export function normalizeSync(input = {}) {
  return { deviceId: id(input.deviceId ?? input.actorId), actorId: id(input.actorId), knownMedia: Array.isArray(input.knownMedia) ? input.knownMedia.map(id) : [] };
}

/**
 * Client Media Delivery integration (Layer 11, Sprint 2).
 *
 * Drives the `/api/media-delivery` engine: progressive media playback (streaming sessions with a buffer,
 * seek, pause/resume), progressive downloads/uploads (chunked with resume), preview + thumbnail
 * rendering, transfer progress, and offline media synchronization. Chunks are OPAQUE ciphertext + a
 * per-chunk hash; the app reassembles the ciphertext and decrypts it DEVICE-SIDE with the injected
 * `decryptFile` hook (the media key came in the message, exactly like Sprint 1).
 *
 * @security This lib exchanges OPAQUE ciphertext chunks + control-plane metadata ONLY — never the media
 * key or plaintext. Reassembly + decryption happen locally.
 *
 * @example
 * ```js
 * import { MediaDeliveryClient } from "../lib/mediaDelivery.js";
 * const delivery = new MediaDeliveryClient({ axios, deviceId, decryptFile });
 * const bytes = await delivery.progressiveDownload(mediaId, { onProgress: (p) => setPct(p) }); // decrypted
 * ```
 */

const BASE = "/api/media-delivery";

export class MediaDeliveryClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   * @param {(args: { ciphertext: Uint8Array, iv: string, authTag: string }) => Promise<Uint8Array>} [deps.decryptFile]
   * @param {(file) => Promise<{ ciphertext: Uint8Array, iv, authTag, keyFingerprint, plaintextHash, plaintextSize }>} [deps.encryptFile]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("MediaDeliveryClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.decryptFile = deps.decryptFile ?? null;
    this.encryptFile = deps.encryptFile ?? null;
    this._liveHandlers = new Set(); // FUTURE live-media seam (inert)
  }

  /** FUTURE live-media seam — inert in Sprint 2. @returns {() => void} */
  onLiveMedia(handler) {
    this._liveHandlers.add(handler);
    return () => this._liveHandlers.delete(handler);
  }

  // === streaming ============================================================

  async startStreaming(mediaId, { chunkSize, bufferChunks } = {}) {
    const { data } = await this.axios.post(`${BASE}/streaming`, { mediaId, deviceId: this.deviceId, chunkSize, bufferChunks });
    return data.session;
  }
  async streamChunk(sessionId, index) {
    const { data } = await this.axios.get(`${BASE}/streaming/${encodeURIComponent(sessionId)}/chunk`, { params: { index } });
    return data; // { chunk, session, nextToFetch }
  }
  async seek(sessionId, index) {
    const { data } = await this.axios.post(`${BASE}/streaming/${encodeURIComponent(sessionId)}/seek`, { index });
    return data;
  }
  async pauseStreaming(sessionId) {
    return (await this.axios.post(`${BASE}/streaming/${encodeURIComponent(sessionId)}/pause`)).data.session;
  }
  async resumeStreaming(sessionId) {
    return (await this.axios.post(`${BASE}/streaming/${encodeURIComponent(sessionId)}/resume`)).data.session;
  }

  /**
   * Progressive playback: stream all chunks in order, reassemble the ciphertext, decrypt device-side.
   * @returns {Promise<Uint8Array>} the decrypted plaintext (needs the media key via decryptFile)
   */
  async streamToEnd(mediaId, { encryption, onProgress } = {}) {
    const session = await this.startStreaming(mediaId);
    const parts = [];
    for (let i = 0; i < session.chunkCount; i++) {
      const { chunk } = await this.streamChunk(session.sessionId, i);
      parts.push(fromBase64(chunk.data));
      if (onProgress) onProgress((i + 1) / session.chunkCount);
    }
    const ciphertext = concat(parts);
    if (this.decryptFile && encryption) return this.decryptFile({ ciphertext, iv: encryption.iv, authTag: encryption.authTag });
    return ciphertext; // opaque if no decrypt hook / encryption provided
  }

  // === progressive transfers ================================================

  async startDownload(mediaId, { priority, chunkSize, window } = {}) {
    const { data } = await this.axios.post(`${BASE}/transfers`, { mediaId, deviceId: this.deviceId, direction: "download", priority, chunkSize, window });
    return data; // { transfer, nextWindow }
  }
  async fetchChunk(transferId, index) {
    const { data } = await this.axios.get(`${BASE}/transfers/${encodeURIComponent(transferId)}/chunk`, { params: { index } });
    return data;
  }
  async resumeTransfer(transferId) {
    const { data } = await this.axios.post(`${BASE}/transfers/${encodeURIComponent(transferId)}/resume`);
    return data; // { transfer, missing, nextWindow }
  }

  /** Progressive download: fetch all chunks (resumable), reassemble, decrypt device-side. */
  async progressiveDownload(mediaId, { encryption, onProgress } = {}) {
    let { transfer } = await this.startDownload(mediaId);
    const parts = new Array(transfer.chunkCount);
    let missing = Array.from({ length: transfer.chunkCount }, (_, i) => i);
    while (missing.length) {
      for (const i of missing) {
        const { chunk } = await this.fetchChunk(transfer.transferId, i);
        parts[i] = fromBase64(chunk.data);
        if (onProgress) onProgress(parts.filter(Boolean).length / transfer.chunkCount);
      }
      const r = await this.resumeTransfer(transfer.transferId);
      missing = r.missing ?? [];
    }
    const ciphertext = concat(parts);
    if (this.decryptFile && encryption) return this.decryptFile({ ciphertext, iv: encryption.iv, authTag: encryption.authTag });
    return ciphertext;
  }

  // === thumbnails + previews + sync =========================================

  async getThumbnail(mediaId, kind) {
    const { data } = await this.axios.get(`${BASE}/media/${encodeURIComponent(mediaId)}/preview`, { params: { kind } });
    return data.preview;
  }
  async generateThumbnail(mediaId, kind) {
    return (await this.axios.post(`${BASE}/media/${encodeURIComponent(mediaId)}/thumbnail`, { kind })).data.preview;
  }
  async synchronize(authoritativeMedia = []) {
    const { data } = await this.axios.post(`${BASE}/sync`, { deviceId: this.deviceId, authoritativeMedia });
    return data; // { plan, delta, replica }
  }
  async offlineQueue() {
    return (await this.axios.get(`${BASE}/devices/${encodeURIComponent(this.deviceId)}/offline-queue`)).data.queue;
  }
  async markAvailable(mediaId) {
    return (await this.axios.post(`${BASE}/media/${encodeURIComponent(mediaId)}/available`, { deviceId: this.deviceId })).data.replica;
  }
}

// --- byte helpers (browser + node) -----------------------------------------
function fromBase64(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function concat(parts) {
  const total = parts.reduce((a, p) => a + (p?.length ?? 0), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    if (p) {
      out.set(p, off);
      off += p.length;
    }
  }
  return out;
}

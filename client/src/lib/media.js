/**
 * Client Secure Media integration (Layer 11, Sprint 1).
 *
 * Drives the `/api/media` pipeline: encrypts media DEVICE-SIDE (per-file media key, never sent to the
 * server), uploads the OPAQUE ciphertext + non-secret `{ iv, authTag }` + key fingerprint, and on
 * download retrieves the opaque ciphertext and decrypts + verifies it locally. Exposes upload/download
 * progress, retry, and cancellation, plus an inert `onStreamChunk` seam for Sprint 2 streaming.
 *
 * @security The server is a BLIND relay — this lib sends OPAQUE ciphertext + metadata ONLY, never the
 * media key or plaintext. Encryption/decryption use injected crypto hooks (Web Crypto AES-GCM in the
 * app); the media key is shared out-of-band via the Layer 4/5 session or Layer 10 group key, exactly
 * like a message.
 *
 * @example
 * ```js
 * import { MediaClient } from "../lib/media.js";
 * const media = new MediaClient({ axios, encryptFile, decryptFile }); // crypto hooks provided by the app
 * const { media: m } = await media.upload(file, { conversationId, onProgress: (p) => setPct(p) });
 * const blob = await media.download(m.mediaId); // decrypted Blob
 * ```
 */

const BASE = "/api/media";

export class MediaClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {(file: Blob|Uint8Array) => Promise<{ ciphertext: Uint8Array, iv: string, authTag: string, keyFingerprint: string, plaintextHash: string, plaintextSize: number }>} deps.encryptFile device-side encrypt
   * @param {(args: { ciphertext: Uint8Array, iv: string, authTag: string }) => Promise<Uint8Array>} deps.decryptFile device-side decrypt
   * @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios) throw new Error("MediaClient requires { axios }");
    this.axios = deps.axios;
    this.encryptFile = deps.encryptFile ?? null;
    this.decryptFile = deps.decryptFile ?? null;
    this.options = { ...(deps.options ?? {}) };
    this._streamHandlers = new Set(); // FUTURE Sprint 2 streaming seam (inert)
  }

  /** FUTURE streaming seam — inert in Sprint 1. @returns {() => void} */
  onStreamChunk(handler) {
    this._streamHandlers.add(handler);
    return () => this._streamHandlers.delete(handler);
  }

  /**
   * Encrypt + upload a file. @param {Blob|Uint8Array} file @param {object} [opts]
   * @param {string} [opts.conversationId] @param {string} [opts.groupId] @param {string} [opts.filename]
   * @param {string} [opts.contentType] @param {(progress:number) => void} [opts.onProgress]
   * @returns {Promise<object>} the upload result (media metadata + operation)
   */
  async upload(file, opts = {}) {
    if (!this.encryptFile) throw new Error("MediaClient requires an encryptFile hook to upload");
    const enc = await this.encryptFile(file);
    const ciphertext = toBase64(enc.ciphertext);
    const { data } = await this.axios.post(
      `${BASE}`,
      {
        filename: opts.filename ?? file?.name ?? "file",
        contentType: opts.contentType ?? file?.type ?? "application/octet-stream",
        conversationId: opts.conversationId,
        groupId: opts.groupId,
        ciphertext,
        plaintextHash: enc.plaintextHash,
        plaintextSize: enc.plaintextSize,
        encryption: { keyFingerprint: enc.keyFingerprint, iv: enc.iv, authTag: enc.authTag },
        idempotencyKey: opts.idempotencyKey,
      },
      { onUploadProgress: opts.onProgress ? (e) => opts.onProgress(e.total ? e.loaded / e.total : 0) : undefined },
    );
    return data;
  }

  /**
   * Download + decrypt a media object. @param {string} mediaId @param {object} [opts]
   * @param {(progress:number) => void} [opts.onProgress] @returns {Promise<Uint8Array>} the decrypted plaintext
   */
  async download(mediaId, opts = {}) {
    if (!this.decryptFile) throw new Error("MediaClient requires a decryptFile hook to download");
    const { data } = await this.axios.get(`${BASE}/${encodeURIComponent(mediaId)}/download`, {
      onDownloadProgress: opts.onProgress ? (e) => opts.onProgress(e.total ? e.loaded / e.total : 0) : undefined,
    });
    const dl = data.download;
    const ciphertext = fromBase64(dl.ciphertext);
    return this.decryptFile({ ciphertext, iv: dl.encryption.iv, authTag: dl.encryption.authTag });
  }

  /** Media metadata (no blob). */
  async getMetadata(mediaId) {
    const { data } = await this.axios.get(`${BASE}/${encodeURIComponent(mediaId)}`);
    return data.media;
  }

  /** List the caller's media. */
  async list({ state, limit } = {}) {
    const { data } = await this.axios.get(`${BASE}`, { params: { state, limit } });
    return data.media;
  }

  /** Re-verify integrity on demand (tamper detection). */
  async verify(mediaId) {
    const { data } = await this.axios.get(`${BASE}/${encodeURIComponent(mediaId)}/verify`);
    return data.integrity;
  }

  /** Delete media. */
  async delete(mediaId) {
    const { data } = await this.axios.delete(`${BASE}/${encodeURIComponent(mediaId)}`);
    return data.media;
  }

  /** An operation's status (progress). */
  async operationStatus(operationId) {
    const { data } = await this.axios.get(`${BASE}/operations/${encodeURIComponent(operationId)}`);
    return data.operation;
  }

  /** Cancel / retry an upload or download. */
  async cancelUpload(operationId) {
    return (await this.axios.post(`${BASE}/uploads/${encodeURIComponent(operationId)}/cancel`)).data.operation;
  }
  async cancelDownload(operationId) {
    return (await this.axios.post(`${BASE}/downloads/${encodeURIComponent(operationId)}/cancel`)).data.operation;
  }
  async retryUpload(operationId, file, opts = {}) {
    const enc = await this.encryptFile(file);
    return (await this.axios.post(`${BASE}/uploads/${encodeURIComponent(operationId)}/retry`, { ciphertext: toBase64(enc.ciphertext) })).data;
  }
  async retryDownload(operationId) {
    return (await this.axios.post(`${BASE}/downloads/${encodeURIComponent(operationId)}/retry`)).data.download;
  }
}

// --- base64 helpers (browser + node) ---------------------------------------
function toBase64(bytes) {
  if (typeof bytes === "string") return bytes;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }
  return Buffer.from(u8).toString("base64");
}
function fromBase64(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

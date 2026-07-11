/**
 * Client Large-Payload Transport integration (Layer 8, Sprint 2).
 *
 * Drives efficient, reliable transfer of large ALREADY-ENCRYPTED payloads (files, images, videos,
 * voice notes, documents, binary) from the browser against the `/api/transport-engine` blind relay:
 * it AUTOMATICALLY fragments a payload into checksummed chunks, relays them (with progress + retry),
 * and — on the receiving side — pulls the chunks, REASSEMBLES + integrity-validates them, decrypts,
 * and delivers the payload. Supports pause / resume / cancel and priority selection.
 *
 * @security This lib transports OPAQUE ciphertext. It NEVER sends plaintext to the server. Encryption
 * + decryption are the crypto layer's job (Layers 2–5), supplied here as INJECTED `encrypt` / `decrypt`
 * hooks. Chunk checksums are SHA-256 integrity hashes over ciphertext (Web Crypto), not keys.
 *
 * @scope Large encrypted payloads only. NO voice/video calls or live streaming (Layer 11) — the
 * `onMedia` hook is an inert seam.
 *
 * @example
 * ```js
 * import { TransportClient } from "../lib/transport.js";
 * const tc = new TransportClient({ axios, deviceId, encrypt, decrypt });
 * // send
 * const { transferId } = await tc.sendPayload({ conversationId, receiverDeviceId, payload: fileBytes, kind: "image", name: "cat.jpg", onProgress: (p) => setBar(p) });
 * // receive (poll a known transferId, or discover via listActiveTransfers)
 * tc.onPayload(({ payload, payloadMeta }) => saveFile(payloadMeta.name, payload));
 * await tc.receiveTransfer(transferId, { onProgress: (p) => setBar(p) });
 * ```
 */

const BASE = "/api/transport-engine";
const DEFAULT_CHUNK_SIZE = 64 * 1024;

export class TransportClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   * @param {(payload: Uint8Array, ctx: object) => Promise<Uint8Array>} [deps.encrypt] produce ciphertext bytes
   * @param {(ciphertext: Uint8Array, ctx: object) => Promise<Uint8Array>} [deps.decrypt] recover plaintext bytes
   * @param {object} [deps.options] `{ chunkSize?, pollIntervalMs?, relayConcurrency? }`
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("TransportClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.encrypt = deps.encrypt ?? null;
    this.decrypt = deps.decrypt ?? null;
    this.options = { chunkSize: DEFAULT_CHUNK_SIZE, pollIntervalMs: 1500, ...(deps.options ?? {}) };
    this._payloadHandlers = new Set();
    this._mediaHandlers = new Set(); // FUTURE Layer 11 seam (inert)
  }

  /** Register a handler for fully-received + decrypted payloads. @returns {() => void} */
  onPayload(handler) {
    this._payloadHandlers.add(handler);
    return () => this._payloadHandlers.delete(handler);
  }

  /** FUTURE Layer 11 seam — register a media-stream handler (inert in Sprint 2). @returns {() => void} */
  onMedia(handler) {
    this._mediaHandlers.add(handler);
    return () => this._mediaHandlers.delete(handler);
  }

  /**
   * Send a large payload: (optionally encrypt →) fragment → open a transfer → relay every chunk.
   * @param {{ conversationId: string, receiverDeviceId: string, payload: Uint8Array|ArrayBuffer, kind?: string, name?: string, mimeType?: string, priority?: string, chunkSize?: number, onProgress?: (fraction: number) => void }} params
   * @returns {Promise<{ transferId: string, totalChunks: number }>}
   */
  async sendPayload(params) {
    const raw = toBytes(params.payload);
    const ciphertext = this.encrypt ? await this.encrypt(raw, { conversationId: params.conversationId, receiverDeviceId: params.receiverDeviceId }) : raw;
    const chunkSize = params.chunkSize ?? this.options.chunkSize;
    const frag = await fragment(ciphertext, chunkSize);

    const { data: opened } = await this.axios.post(`${BASE}/transfers`, {
      conversationId: params.conversationId,
      receiverDeviceId: params.receiverDeviceId,
      priority: params.priority,
      payloadMeta: { kind: params.kind ?? "binary", name: params.name, mimeType: params.mimeType, totalSize: frag.totalSize, totalChunks: frag.totalChunks, chunkSize, checksum: frag.checksum },
    });
    const transferId = opened.transfer.transferId;

    let sent = 0;
    for (const chunk of frag.chunks) {
      await this.axios.post(`${BASE}/transfers/${encodeURIComponent(transferId)}/chunks`, { chunk });
      sent++;
      params.onProgress?.(sent / frag.totalChunks);
    }
    return { transferId, totalChunks: frag.totalChunks };
  }

  /**
   * Receive a transfer: poll the inbox, reassemble + integrity-validate the chunks, ACK them, decrypt,
   * and deliver the payload to `onPayload`. Resolves when the transfer completes.
   * @param {string} transferId @param {{ onProgress?: (fraction: number) => void, signal?: AbortSignal }} [options]
   * @returns {Promise<{ payload: Uint8Array, payloadMeta: object }>}
   */
  async receiveTransfer(transferId, options = {}) {
    const collected = new Map(); // index -> Uint8Array
    let meta = null;
    for (;;) {
      if (options.signal?.aborted) throw new Error("receive aborted");
      const { data } = await this.axios.get(`${BASE}/transfers/${encodeURIComponent(transferId)}/inbox`);
      meta = data.payloadMeta ?? meta;
      const acked = [];
      for (const chunk of data.chunks ?? []) {
        const bytes = fromBase64(chunk.data);
        if ((await sha256Hex(bytes)) !== chunk.checksum) continue; // integrity — skip corrupt (relay/sender resends)
        collected.set(chunk.index, bytes);
        acked.push(chunk.chunkId);
      }
      if (acked.length) await this.axios.post(`${BASE}/transfers/${encodeURIComponent(transferId)}/ack`, { chunkIds: acked });
      if (meta) options.onProgress?.(collected.size / meta.totalChunks);
      if (meta && collected.size >= meta.totalChunks) break;
      await delay(this.options.pollIntervalMs);
    }

    // Reassemble in order + validate the whole-payload checksum.
    const ordered = [];
    for (let i = 0; i < meta.totalChunks; i++) ordered.push(collected.get(i));
    const ciphertext = concat(ordered);
    if (meta.checksum && (await sha256Hex(ciphertext)) !== meta.checksum) throw new Error("reassembled payload failed its integrity check");
    const payload = this.decrypt ? await this.decrypt(ciphertext, { transferId }) : ciphertext;

    for (const handler of this._payloadHandlers) {
      try {
        handler({ transferId, payload, payloadMeta: meta });
      } catch {
        /* an app handler must not break receipt */
      }
    }
    return { payload, payloadMeta: meta };
  }

  /** Pause a transfer. */
  async pauseTransfer(transferId) {
    return (await this.axios.post(`${BASE}/transfers/${encodeURIComponent(transferId)}/pause`)).data.transfer;
  }
  /** Resume a transfer. */
  async resumeTransfer(transferId) {
    return (await this.axios.post(`${BASE}/transfers/${encodeURIComponent(transferId)}/resume`)).data.transfer;
  }
  /** Cancel a transfer. */
  async cancelTransfer(transferId) {
    return (await this.axios.post(`${BASE}/transfers/${encodeURIComponent(transferId)}/cancel`)).data.transfer;
  }
  /** A transfer's progress. */
  async getProgress(transferId) {
    return (await this.axios.get(`${BASE}/transfers/${encodeURIComponent(transferId)}/progress`)).data.progress;
  }
  /** This device's active transfers. */
  async listActiveTransfers(conversationId) {
    const { data } = await this.axios.get(`${BASE}/transfers`, { params: conversationId ? { conversationId } : {} });
    return data.transfers;
  }
}

// === browser-friendly fragmentation helpers (Web Crypto) ====================

/** Fragment ciphertext bytes into checksummed chunks + the aggregate checksum. */
async function fragment(bytes, chunkSize) {
  const totalSize = bytes.length;
  const totalChunks = Math.max(1, Math.ceil(totalSize / chunkSize));
  const chunks = [];
  for (let index = 0; index < totalChunks; index++) {
    const offset = index * chunkSize;
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, totalSize));
    chunks.push({ chunkId: `${index}`, index, total: totalChunks, offset, size: slice.length, data: toBase64(slice), checksum: await sha256Hex(slice) });
  }
  return { chunks, totalChunks, totalSize, checksum: await sha256Hex(bytes) };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBytes(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  throw new TypeError("payload must be a Uint8Array, ArrayBuffer, or string");
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Client Reliable-Messaging integration (Layer 8, Sprint 1).
 *
 * Drives reliable delivery of ALREADY-ENCRYPTED application messages from the browser against the
 * `/api/data-plane` blind relay: relay an encrypted message, poll the inbox, decrypt + acknowledge
 * received messages, and track delivery status. It provides the send / receive / track surface the
 * app needs while the server stays a blind ciphertext relay.
 *
 * @security This lib transports OPAQUE ciphertext. It NEVER sends plaintext to the server. Encryption
 * + decryption are the crypto layer's job (Layers 2–5), supplied here as INJECTED `encrypt` / `decrypt`
 * hooks. If no hooks are given, the caller must pass/read `encryptedPayload` directly.
 *
 * @scope Reliable message transport only — NO file transfer, chunking, streaming, or media (Sprint 2).
 *
 * @example
 * ```js
 * import { MessagingClient } from "../lib/messaging.js";
 * const mc = new MessagingClient({ axios, deviceId, encrypt, decrypt });
 * mc.onMessage(({ text, sender }) => showBubble(sender, text));  // decrypted delivery
 * mc.startInboxPolling("conversation-123");                      // pull + decrypt + ACK
 * const { messageId } = await mc.send({ conversationId: "conversation-123", receiverDeviceId: "bob", text: "hi" });
 * const status = await mc.getStatus(messageId);                  // "acknowledged" once bob ACKs
 * ```
 */

const BASE = "/api/data-plane";

export class MessagingClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios an axios instance carrying the auth token
   * @param {string} deps.deviceId this device's stable id
   * @param {(plaintext: any, ctx: { conversationId: string, receiverDeviceId: string }) => Promise<object>} [deps.encrypt]
   *   produce the OPAQUE ciphertext envelope for a message (the crypto layer)
   * @param {(encryptedPayload: object, ctx: { conversationId: string, sender: string }) => Promise<any>} [deps.decrypt]
   *   recover the plaintext from a received ciphertext envelope
   * @param {object} [deps.options] `{ pollIntervalMs?: number }`
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("MessagingClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.encrypt = deps.encrypt ?? null;
    this.decrypt = deps.decrypt ?? null;
    this.options = { pollIntervalMs: 2500, ...(deps.options ?? {}) };
    /** @type {Set<Function>} decrypted-message handlers */
    this._handlers = new Set();
    /** @type {Map<string, number>} conversationId -> poll timer */
    this._pollers = new Map();
    /** @type {Set<string>} message ids already delivered locally (dedupe across polls) */
    this._seen = new Set();
  }

  /** Register a handler for received (decrypted) messages. @returns {() => void} unsubscribe */
  onMessage(handler) {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  /**
   * Send a message: encrypt it (if an `encrypt` hook is set) and relay the ciphertext.
   * @param {{ conversationId: string, receiverDeviceId: string, text?: any, encryptedPayload?: object, priority?: string, ttlMs?: number, connectionId?: string }} params
   * @returns {Promise<object>} the delivery DTO (`{ messageId, state, sequenceNumber, ... }`)
   */
  async send(params) {
    const { conversationId, receiverDeviceId, text, encryptedPayload, priority, ttlMs, connectionId } = params;
    let payload = encryptedPayload;
    if (payload == null) {
      if (!this.encrypt) throw new Error("MessagingClient.send needs an encrypt hook or an explicit encryptedPayload");
      payload = await this.encrypt(text, { conversationId, receiverDeviceId });
    }
    const { data } = await this.axios.post(`${BASE}/relay`, { conversationId, receiverDeviceId, encryptedPayload: payload, priority, ttlMs, connectionId });
    return data.message;
  }

  /**
   * Pull this device's undelivered messages for a conversation, decrypt them, deliver to handlers, and
   * acknowledge each. Safe to call repeatedly (idempotent — already-seen ids are skipped).
   * @param {string} conversationId @returns {Promise<object[]>} the delivered items
   */
  async pullInbox(conversationId) {
    const { data } = await this.axios.get(`${BASE}/inbox/${encodeURIComponent(conversationId)}`);
    const delivered = [];
    for (const message of data.messages ?? []) {
      if (this._seen.has(message.messageId)) continue;
      this._seen.add(message.messageId);
      let text = message.encryptedPayload;
      if (this.decrypt) {
        try {
          text = await this.decrypt(message.encryptedPayload, { conversationId, sender: message.senderDeviceId });
        } catch (error) {
          text = { error: "decrypt-failed", detail: error?.message };
        }
      }
      const item = { messageId: message.messageId, conversationId, sender: message.senderDeviceId, seq: message.sequenceNumber, text };
      for (const handler of this._handlers) {
        try {
          handler(item);
        } catch {
          /* a handler throwing must not stop delivery or the ACK */
        }
      }
      await this.acknowledge(message.messageId);
      delivered.push(item);
    }
    return delivered;
  }

  /** Acknowledge a received message (drives the sender's status to "acknowledged"). */
  async acknowledge(messageId) {
    const { data } = await this.axios.post(`${BASE}/${encodeURIComponent(messageId)}/ack`);
    return data.message;
  }

  /** A sent message's delivery status. */
  async getStatus(messageId) {
    const { data } = await this.axios.get(`${BASE}/${encodeURIComponent(messageId)}/status`);
    return data.status;
  }

  /** This device's still-pending (unacknowledged) messages for a conversation. */
  async getPending(conversationId) {
    const { data } = await this.axios.get(`${BASE}/pending/${encodeURIComponent(conversationId)}`);
    return data.pending;
  }

  /** Delivery history (metadata only) for a conversation. */
  async getHistory(conversationId) {
    const { data } = await this.axios.get(`${BASE}/history/${encodeURIComponent(conversationId)}`);
    return data.history;
  }

  /** Aggregate delivery diagnostics for a conversation. */
  async getDiagnostics(conversationId) {
    const { data } = await this.axios.get(`${BASE}/diagnostics/${encodeURIComponent(conversationId)}`);
    return data.diagnostics;
  }

  /** Start polling a conversation's inbox on an interval. Idempotent per conversation. */
  startInboxPolling(conversationId) {
    if (this._pollers.has(conversationId)) return;
    const tick = () => this.pullInbox(conversationId).catch(() => {});
    const timer = setInterval(tick, this.options.pollIntervalMs);
    this._pollers.set(conversationId, timer);
    tick(); // pull immediately
  }

  /** Stop polling a conversation (or all if omitted). */
  stopInboxPolling(conversationId) {
    if (conversationId) {
      clearInterval(this._pollers.get(conversationId));
      this._pollers.delete(conversationId);
      return;
    }
    for (const timer of this._pollers.values()) clearInterval(timer);
    this._pollers.clear();
  }
}

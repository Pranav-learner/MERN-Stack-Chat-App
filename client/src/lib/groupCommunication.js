/**
 * Client Group Communication integration (Layer 10, Sprint 2).
 *
 * Drives the `/api/group-communication` engine: secure group messaging, group key management +
 * automatic rekeying, fan-out + delivery status, group synchronization, and offline recovery. It treats
 * a group as a live end-to-end-encrypted channel the UI sends into + renders, and surfaces message,
 * rekey, delivery, replica, and sync changes to the app via subscribable hooks.
 *
 * @security This lib exchanges key METADATA (versions + fingerprints) + OPAQUE ciphertext ONLY with the
 * engine — never group-key bytes or plaintext. Encrypting the plaintext under the device-local group key
 * and decrypting inbound ciphertext are the APP's job, supplied as INJECTED hooks (`encryptForGroup` /
 * `decryptFromGroup`). The engine never sees a key or a plaintext byte.
 *
 * @scope Sprint 2 = messaging + keys + rekey + fan-out + sync + offline. Group read receipts / delivery
 * aggregation are Sprint 4 — the `onReceiptHook` here is an inert seam.
 *
 * @example
 * ```js
 * import { GroupCommunicationClient } from "../lib/groupCommunication.js";
 * const gc = new GroupCommunicationClient({ axios, deviceId, encryptForGroup, decryptFromGroup });
 * gc.onMessage(async ({ messageId, ciphertext }) => renderIncoming(await gc.decrypt(ciphertext)));
 * await gc.establishKey(groupId);
 * await gc.sendMessage(groupId, "hello team");
 * ```
 */

const BASE = "/api/group-communication";

export class GroupCommunicationClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   * @param {(groupId: string, plaintext: any) => Promise<string>} [deps.encryptForGroup] encrypt under the device-local group key → ciphertext
   * @param {(ciphertext: string) => Promise<any>} [deps.decryptFromGroup] decrypt inbound ciphertext
   * @param {() => Promise<{ fingerprint: string }>} [deps.deriveKeyFingerprint] device-side epoch derivation → public fingerprint
   * @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("GroupCommunicationClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this.encryptForGroup = deps.encryptForGroup ?? null;
    this.decryptFromGroup = deps.decryptFromGroup ?? null;
    this.deriveKeyFingerprint = deps.deriveKeyFingerprint ?? null;
    this.options = { autoSyncMs: 60_000, ...(deps.options ?? {}) };
    this._messageHandlers = new Set();
    this._rekeyHandlers = new Set();
    this._deliveryHandlers = new Set();
    this._replicaHandlers = new Set();
    this._syncHandlers = new Set();
    this._receiptHandlers = new Set(); // FUTURE Sprint 4 read-receipt seam (inert)
    this._autoTimers = new Map();
  }

  // === subscriptions ========================================================

  /** Subscribe to inbound group messages (ciphertext refs). @returns {() => void} */
  onMessage(handler) { this._messageHandlers.add(handler); return () => this._messageHandlers.delete(handler); }
  /** Subscribe to rekey / key-rotation notifications. @returns {() => void} */
  onRekey(handler) { this._rekeyHandlers.add(handler); return () => this._rekeyHandlers.delete(handler); }
  /** Subscribe to delivery-status updates. @returns {() => void} */
  onDelivery(handler) { this._deliveryHandlers.add(handler); return () => this._deliveryHandlers.delete(handler); }
  /** Subscribe to replica refreshes. @returns {() => void} */
  onReplica(handler) { this._replicaHandlers.add(handler); return () => this._replicaHandlers.delete(handler); }
  /** Subscribe to synchronization results. @returns {() => void} */
  onSync(handler) { this._syncHandlers.add(handler); return () => this._syncHandlers.delete(handler); }
  /** FUTURE Sprint 4 read-receipt seam — inert. @returns {() => void} */
  onReceiptHook(handler) { this._receiptHandlers.add(handler); return () => this._receiptHandlers.delete(handler); }

  // === keys + rekey =========================================================

  /** Establish the initial group key (device derives locally; only the fingerprint is posted). */
  async establishKey(groupId, ttlMs) {
    const fingerprint = this.deriveKeyFingerprint ? (await this.deriveKeyFingerprint()).fingerprint : undefined;
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/keys/establish`, { fingerprint, ttlMs });
    return data.key;
  }

  /** Rotate the group key (rekey). */
  async rotateKey(groupId, { trigger = "manual", affectedMember, ttlMs } = {}) {
    const fingerprint = this.deriveKeyFingerprint ? (await this.deriveKeyFingerprint({ fresh: true })).fingerprint : undefined;
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/keys/rotate`, { trigger, affectedMember, fingerprint, ttlMs });
    this._fan(this._rekeyHandlers, data.key);
    return data.key;
  }

  async keyVersion(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/keys/version`);
    return data;
  }
  async listKeys(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/keys`);
    return data.keys;
  }

  // === messaging + fan-out ==================================================

  /** Encrypt a plaintext under the group key + send it. The engine only ever sees ciphertext. */
  async sendMessage(groupId, plaintext, { priority, metadata } = {}) {
    const ciphertext = this.encryptForGroup ? await this.encryptForGroup(groupId, plaintext) : plaintext;
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/messages`, { ciphertext, senderDeviceId: this.deviceId, priority, metadata });
    this._fan(this._deliveryHandlers, data.fanout);
    return data;
  }

  /** Confirm receipt of a message on this device (drives delivery status). */
  async confirmReceipt(groupId, messageId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/receive`, { deviceId: this.deviceId });
    return data;
  }

  /** Fetch + decrypt a message body (for a member). */
  async readMessage(groupId, messageId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}`, { params: { ciphertext: 1 } });
    const message = data.message;
    if (message?.ciphertext && this.decryptFromGroup) message.plaintext = await this.decryptFromGroup(message.ciphertext);
    return message;
  }

  async listMessages(groupId, { limit, offset } = {}) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/messages`, { params: { limit, offset } });
    return data.messages;
  }
  async deliveryStatus(groupId, messageId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/delivery`);
    this._fan(this._deliveryHandlers, data.delivery);
    return data.delivery;
  }
  async fanoutDiagnostics(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/fanout/diagnostics`);
    return data.diagnostics;
  }

  /** Decrypt a ciphertext with the injected hook (convenience for onMessage handlers). */
  async decrypt(ciphertext) {
    return this.decryptFromGroup ? this.decryptFromGroup(ciphertext) : ciphertext;
  }

  // === offline recovery + sync ==============================================

  /** Resume deferred deliveries for this device (call on reconnect). */
  async resume(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/resume`, { deviceId: this.deviceId });
    return data;
  }

  async pendingMembers(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/pending`);
    return data.pending;
  }

  /** Synchronize this device's replica (membership / metadata / key-version / replica + missed msgs). */
  async synchronize(groupId, replica) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/sync`, { deviceId: this.deviceId, replica });
    this._fan(this._syncHandlers, data);
    this._fan(this._replicaHandlers, data.replica);
    return data;
  }

  /** Register / refresh this device's replica. */
  async registerReplica(groupId, { facetVersions, keyVersion } = {}) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/replicas`, { deviceId: this.deviceId, facetVersions, keyVersion });
    this._fan(this._replicaHandlers, data.replica);
    return data.replica;
  }
  async getReplica(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/replicas/${encodeURIComponent(this.deviceId)}`);
    return data.replica;
  }

  /** On reconnect: sync the replica + resume deferred deliveries. */
  async onReconnect(groupId) {
    const sync = await this.synchronize(groupId);
    const resume = await this.resume(groupId);
    return { sync, resume };
  }

  /** Start periodic background sync for a group. Idempotent per group. */
  startAutoSync(groupId, params = {}) {
    if (this._autoTimers.has(groupId)) return;
    const intervalMs = params.intervalMs ?? this.options.autoSyncMs;
    const timer = setInterval(() => this.synchronize(groupId).catch(() => {}), intervalMs);
    this._autoTimers.set(groupId, timer);
  }
  stopAutoSync(groupId) {
    const t = this._autoTimers.get(groupId);
    if (t) clearInterval(t);
    this._autoTimers.delete(groupId);
  }

  _fan(handlers, payload) {
    for (const h of handlers) try { h(payload); } catch { /* ignore */ }
  }
}

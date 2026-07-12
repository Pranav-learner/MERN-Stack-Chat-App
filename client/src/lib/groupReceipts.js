/**
 * Client Group Delivery Intelligence integration (Layer 10, Sprint 4).
 *
 * Drives the `/api/group-receipts` subsystem: registers a group message for receipt tracking, reports
 * this device's delivery + read, and reads the WhatsApp-style receipt (✓ / ✓✓ / ✓✓-blue), reader list,
 * pending/offline members, and analytics. It renders the tick a group chat UI shows next to each sent
 * message and surfaces live receipt updates.
 *
 * @security This lib exchanges delivery CONTROL-PLANE metadata ONLY with the subsystem — message/member/
 * device ids, delivery/read states, timestamps, counts — never message content or keys.
 *
 * @example
 * ```js
 * import { GroupReceiptsClient, TICK } from "../lib/groupReceipts.js";
 * const receipts = new GroupReceiptsClient({ axios, deviceId });
 * receipts.onTick(({ messageId, tick }) => setTick(messageId, tick));
 * await receipts.registerMessage({ messageId, groupId, applicableMembers });
 * await receipts.markRead(messageId);            // when the local user opens the chat
 * const r = await receipts.getReceipt(messageId); // { tick, delivered, read, pending, ... }
 * ```
 */

const BASE = "/api/group-receipts";

/** WhatsApp-style tick constants (mirrors the server `ReceiptTick`). */
export const TICK = Object.freeze({ SINGLE: "single", GREY_DOUBLE: "grey-double", BLUE_DOUBLE: "blue-double" });

/** Map a tick to a renderable indicator hint. */
export function tickIndicator(tick) {
  switch (tick) {
    case TICK.BLUE_DOUBLE:
      return { ticks: 2, color: "blue", label: "Read" };
    case TICK.GREY_DOUBLE:
      return { ticks: 2, color: "grey", label: "Delivered" };
    default:
      return { ticks: 1, color: "grey", label: "Sent" };
  }
}

export class GroupReceiptsClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} deps.deviceId this device's id
   */
  constructor(deps) {
    if (!deps?.axios || !deps?.deviceId) throw new Error("GroupReceiptsClient requires { axios, deviceId }");
    this.axios = deps.axios;
    this.deviceId = String(deps.deviceId);
    this._tickHandlers = new Set();
    this._receiptHandlers = new Set();
  }

  /** Subscribe to tick updates. @returns {() => void} */
  onTick(handler) { this._tickHandlers.add(handler); return () => this._tickHandlers.delete(handler); }
  /** Subscribe to full receipt updates. @returns {() => void} */
  onReceipt(handler) { this._receiptHandlers.add(handler); return () => this._receiptHandlers.delete(handler); }

  /**
   * Feed a server-pushed receipt event (e.g. via socket) into the client so subscribers update. Pass the
   * `group-receipts.receipt_updated` / `group-receipts.aggregation_updated` event payload.
   */
  ingestEvent(event) {
    if (!event?.messageId) return;
    if (event.tick != null) this._fan(this._tickHandlers, { messageId: event.messageId, tick: event.tick });
    this._fan(this._receiptHandlers, event);
  }

  // === registration + tracking ==============================================

  /** Register a group message for receipt tracking (call when sending). */
  async registerMessage({ messageId, groupId, applicableMembers, policy, readExcludedMembers } = {}) {
    const { data } = await this.axios.post(`${BASE}/messages`, { messageId, groupId, applicableMembers, policy, readExcludedMembers });
    return data.receipt;
  }

  /** Report that this device received (was delivered) the message. */
  async markDelivered(messageId, { status } = {}) {
    const { data } = await this.axios.post(`${BASE}/messages/${encodeURIComponent(messageId)}/delivered`, { deviceId: this.deviceId, status });
    return data.member;
  }

  /** Report that this device read the message (when the local user opens/views it). */
  async markRead(messageId) {
    const { data } = await this.axios.post(`${BASE}/messages/${encodeURIComponent(messageId)}/read`, { deviceId: this.deviceId });
    return data.member;
  }

  // === receipt reads ========================================================

  /** The receipt status (tick + counts). */
  async getReceipt(messageId) {
    const { data } = await this.axios.get(`${BASE}/messages/${encodeURIComponent(messageId)}`);
    this._fan(this._tickHandlers, { messageId, tick: data.receipt?.tick });
    return data.receipt;
  }

  /** Just the tick (WhatsApp indicator). */
  async getTick(messageId) {
    return (await this.getReceipt(messageId)).tick;
  }

  /** The reader list (member read list). */
  async getReaders(messageId, { limit, offset } = {}) {
    const { data } = await this.axios.get(`${BASE}/messages/${encodeURIComponent(messageId)}/readers`, { params: { limit, offset } });
    return data;
  }

  /** The pending member list. */
  async getPending(messageId, { limit, offset } = {}) {
    const { data } = await this.axios.get(`${BASE}/messages/${encodeURIComponent(messageId)}/pending`, { params: { limit, offset } });
    return data;
  }

  /** The offline member list (offline indicators). */
  async getOffline(messageId) {
    const { data } = await this.axios.get(`${BASE}/messages/${encodeURIComponent(messageId)}/offline`);
    return data;
  }

  /** A single member's receipt. */
  async getMemberReceipt(messageId, memberId) {
    const { data } = await this.axios.get(`${BASE}/messages/${encodeURIComponent(messageId)}/member/${encodeURIComponent(memberId)}`);
    return data.member;
  }

  /** Full analytics (future group insights / dashboards). */
  async getAnalytics(messageId, { offline } = {}) {
    const { data } = await this.axios.get(`${BASE}/messages/${encodeURIComponent(messageId)}/analytics`, { params: { offline: offline ? 1 : undefined } });
    return data.analytics;
  }

  /** Recent receipts for a group (dashboard). */
  async listGroupReceipts(groupId, limit) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/receipts`, { params: { limit } });
    return data.receipts;
  }

  _fan(handlers, payload) {
    for (const h of handlers) try { h(payload); } catch { /* ignore */ }
  }
}

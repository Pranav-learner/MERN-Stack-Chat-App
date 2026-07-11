/**
 * @module network-reliability/repository/inMemory
 *
 * In-memory Network Reliability repositories: the reference for the store contracts + the test
 * backend. Bundles three stores:
 *
 * - `connections` — active connection records (the reliability view; candidates + session id, no keys).
 * - `recovery` — an append-only recovery history (for diagnostics + change tracking).
 * - `alerts` — persisted reliability alerts the monitor raises.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## Connection store contract (shared with Mongo)
 * - `create(conn) -> conn` · `findById(connectionId) -> conn | null` · `update(id, patch) -> conn`
 * - `delete(id) -> boolean` · `findByDeviceAndPeer(deviceId, peerId) -> conn | null`
 * - `listByDevice(deviceId, { limit }) -> conn[]` · `listLive() -> conn[]`
 * - `listTimedOut(nowIso) -> conn[]` (live conns whose heartbeat window elapsed) · `countByState() -> {}`
 */

import { ConnectionNotFoundError } from "../errors.js";
import { LIVE_CONNECTION_STATES, ConnectionState } from "../types/types.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const LIVE = new Set(LIVE_CONNECTION_STATES);
// Connections a heartbeat sweep should consider for timeout (live + transient).
const SWEEPABLE = new Set([...LIVE_CONNECTION_STATES, ConnectionState.CONNECTING, ConnectionState.RECONNECTING]);

/** @returns {{ connections: object, recovery: object, alerts: object, reset: () => void }} */
export function createInMemoryReliabilityRepository() {
  /** @type {Map<string, object>} connectionId -> connection */
  const byId = new Map();
  /** @type {Map<string, string>} `${deviceId}|${peerId}` -> connectionId */
  const byPair = new Map();
  /** @type {object[]} recovery history */
  const recoveryLog = [];
  /** @type {object[]} alerts */
  const alertLog = [];

  const pkey = (deviceId, peerId) => `${deviceId}|${peerId}`;

  const connections = {
    async create(conn) {
      byId.set(conn.connectionId, clone(conn));
      byPair.set(pkey(conn.deviceId, conn.peerId), conn.connectionId);
      return clone(conn);
    },
    async findById(connectionId) {
      const c = byId.get(String(connectionId));
      return c ? clone(c) : null;
    },
    async findByDeviceAndPeer(deviceId, peerId) {
      const id = byPair.get(pkey(String(deviceId), String(peerId)));
      const c = id ? byId.get(id) : null;
      return c ? clone(c) : null;
    },
    async update(connectionId, patch) {
      const key = String(connectionId);
      const existing = byId.get(key);
      if (!existing) throw new ConnectionNotFoundError("Active connection not found", { details: { connectionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(key, clone(updated));
      byPair.set(pkey(updated.deviceId, updated.peerId), key);
      return clone(updated);
    },
    async delete(connectionId) {
      const key = String(connectionId);
      const existing = byId.get(key);
      if (existing) byPair.delete(pkey(existing.deviceId, existing.peerId));
      return byId.delete(key);
    },
    async listByDevice(deviceId, options = {}) {
      const did = String(deviceId);
      const list = [...byId.values()].filter((c) => c.deviceId === did).sort((a, b) => (a.establishedAt < b.establishedAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listLive() {
      return [...byId.values()].filter((c) => LIVE.has(c.state)).map(clone);
    },
    async listTimedOut(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()]
        .filter((c) => SWEEPABLE.has(c.state) && c.heartbeatExpiresAt && new Date(c.heartbeatExpiresAt).getTime() <= now)
        .map(clone);
    },
    async countByState() {
      const counts = {};
      for (const c of byId.values()) counts[c.state] = (counts[c.state] ?? 0) + 1;
      return counts;
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  const recovery = {
    async record(rec) {
      recoveryLog.push(clone(rec));
      return clone(rec);
    },
    async listByConnection(connectionId, options = {}) {
      const cid = String(connectionId);
      const list = recoveryLog.filter((r) => r.connectionId === cid).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listAll() {
      return recoveryLog.map(clone);
    },
  };

  const alerts = {
    async record(alert) {
      alertLog.push(clone(alert));
      return clone(alert);
    },
    async list(options = {}) {
      let out = alertLog;
      if (options.alertType) out = out.filter((a) => a.alertType === options.alertType);
      out = [...out].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      const offset = options.offset ?? 0;
      return out.slice(offset, offset + (options.limit ?? 50)).map(clone);
    },
    async count(options = {}) {
      return (options.alertType ? alertLog.filter((a) => a.alertType === options.alertType) : alertLog).length;
    },
  };

  return {
    connections,
    recovery,
    alerts,
    reset: () => {
      byId.clear();
      byPair.clear();
      recoveryLog.length = 0;
      alertLog.length = 0;
    },
  };
}

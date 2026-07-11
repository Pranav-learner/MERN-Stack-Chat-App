/**
 * @module presence/repository/inMemory
 *
 * In-memory Presence repository: the reference for the repository contract and the test/device
 * backend. One record per `(userId, deviceId)`. Records are deep-copied on the way in and out.
 * Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## Presence store contract (shared with Mongo)
 * - `upsert(record) -> record`                    (create-or-replace by presenceId)
 * - `create(record) -> record`
 * - `findById(presenceId) -> record | null`
 * - `findByUserAndDevice(userId, deviceId) -> record | null`
 * - `findByUser(userId) -> record[]`              (all a user's devices)
 * - `update(presenceId, patch) -> record`
 * - `delete(presenceId) -> boolean`
 * - `listByStatus(status) -> record[]`
 * - `listReachableByUser(userId) -> record[]`     (reachable devices of a user)
 * - `listExpired(nowIso) -> record[]`             (reachable-ish records past their expiry)
 * - `countByStatus() -> Record<status, number>`
 * - `listAll() -> record[]`
 */

import { PresenceNotFoundError } from "../errors.js";
import { REACHABLE_PRESENCE_STATUSES, PresenceStatus } from "../types/types.js";
import { presenceKey } from "../record/presenceRecord.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const REACHABLE = new Set(REACHABLE_PRESENCE_STATUSES);
// Records that a heartbeat sweep should consider for expiry (reachable + transitional).
const SWEEPABLE = new Set([...REACHABLE_PRESENCE_STATUSES, PresenceStatus.RECONNECTING, PresenceStatus.DISCONNECTED]);

/** @returns {{ presence: object, reset: () => void }} */
export function createInMemoryPresenceRepository() {
  /** @type {Map<string, object>} presenceId -> record */
  const byId = new Map();
  /** @type {Map<string, string>} `${userId}|${deviceId}` -> presenceId */
  const idByDevice = new Map();

  const presence = {
    async upsert(record) {
      const dkey = presenceKey(record.userId, record.deviceId);
      const existingId = idByDevice.get(dkey);
      if (existingId && existingId !== record.presenceId) {
        // Same device re-registered under a new presenceId: drop the stale mapping/record.
        byId.delete(existingId);
      }
      byId.set(record.presenceId, clone(record));
      idByDevice.set(dkey, record.presenceId);
      return clone(record);
    },
    async create(record) {
      byId.set(record.presenceId, clone(record));
      idByDevice.set(presenceKey(record.userId, record.deviceId), record.presenceId);
      return clone(record);
    },
    async findById(presenceId) {
      const r = byId.get(String(presenceId));
      return r ? clone(r) : null;
    },
    async findByUserAndDevice(userId, deviceId) {
      const id = idByDevice.get(presenceKey(String(userId), String(deviceId)));
      const r = id ? byId.get(id) : null;
      return r ? clone(r) : null;
    },
    async findByUser(userId) {
      const uid = String(userId);
      return [...byId.values()].filter((r) => r.userId === uid).map(clone);
    },
    async update(presenceId, patch) {
      const key = String(presenceId);
      const existing = byId.get(key);
      if (!existing) throw new PresenceNotFoundError("Presence record not found", { details: { presenceId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(key, clone(updated));
      idByDevice.set(presenceKey(updated.userId, updated.deviceId), key);
      return clone(updated);
    },
    async delete(presenceId) {
      const key = String(presenceId);
      const existing = byId.get(key);
      if (existing) idByDevice.delete(presenceKey(existing.userId, existing.deviceId));
      return byId.delete(key);
    },
    async listByStatus(status) {
      return [...byId.values()].filter((r) => r.status === status).map(clone);
    },
    async listReachableByUser(userId) {
      const uid = String(userId);
      return [...byId.values()].filter((r) => r.userId === uid && REACHABLE.has(r.status)).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()]
        .filter((r) => SWEEPABLE.has(r.status) && r.expiresAt && new Date(r.expiresAt).getTime() <= now)
        .map(clone);
    },
    async countByStatus() {
      const counts = {};
      for (const r of byId.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return counts;
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  return {
    presence,
    reset: () => {
      byId.clear();
      idByDevice.clear();
    },
  };
}

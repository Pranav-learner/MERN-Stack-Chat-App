/**
 * @module capabilities/repository/inMemory
 *
 * In-memory Capability repositories: the reference for the repository contract and the test/device
 * backend. Bundles the two stores the subsystem needs:
 *
 * - `capabilities` — one capability set per `(userId, deviceId)`.
 * - `negotiations` — an append-only negotiation history.
 *
 * Records are deep-copied on the way in and out. Imports no driver, so the whole stack runs under
 * `node --test`.
 *
 * ## Capability store contract (shared with Mongo)
 * - `upsert(record) -> record`                      (create-or-replace by capabilityId)
 * - `create(record) -> record`
 * - `findById(capabilityId) -> record | null`
 * - `findByUserAndDevice(userId, deviceId) -> record | null`
 * - `findByUser(userId) -> record[]`
 * - `update(capabilityId, patch) -> record`
 * - `delete(capabilityId) -> boolean`
 * - `listByState(state) -> record[]`
 * - `listExpired(nowIso) -> record[]`               (live sets past their TTL)
 * - `countByState() -> Record<state, number>`
 * - `listAll() -> record[]`
 *
 * ## Negotiation store contract (shared with Mongo)
 * - `record(negotiation) -> negotiation`
 * - `findById(negotiationId) -> negotiation | null`
 * - `listByDevice(userId, deviceId, { limit }) -> negotiation[]`
 * - `listByPair(userId, deviceId, targetUser, targetDevice, { limit }) -> negotiation[]`
 * - `listAll() -> negotiation[]`
 */

import { CapabilityNotFoundError } from "../errors.js";
import { NEGOTIABLE_CAPABILITY_STATES } from "../types/types.js";
import { capabilityKey } from "../record/capabilityRecord.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const LIVE = new Set(NEGOTIABLE_CAPABILITY_STATES);

/** @returns {{ capabilities: object, negotiations: object, reset: () => void }} */
export function createInMemoryCapabilityRepository() {
  /** @type {Map<string, object>} capabilityId -> record */
  const byId = new Map();
  /** @type {Map<string, string>} `${userId}|${deviceId}` -> capabilityId */
  const idByDevice = new Map();
  /** @type {Map<string, object>} negotiationId -> record */
  const negotiationsById = new Map();

  const capabilities = {
    async upsert(record) {
      const dkey = capabilityKey(record.userId, record.deviceId);
      const existingId = idByDevice.get(dkey);
      if (existingId && existingId !== record.capabilityId) byId.delete(existingId);
      byId.set(record.capabilityId, clone(record));
      idByDevice.set(dkey, record.capabilityId);
      return clone(record);
    },
    async create(record) {
      byId.set(record.capabilityId, clone(record));
      idByDevice.set(capabilityKey(record.userId, record.deviceId), record.capabilityId);
      return clone(record);
    },
    async findById(capabilityId) {
      const r = byId.get(String(capabilityId));
      return r ? clone(r) : null;
    },
    async findByUserAndDevice(userId, deviceId) {
      const id = idByDevice.get(capabilityKey(String(userId), String(deviceId)));
      const r = id ? byId.get(id) : null;
      return r ? clone(r) : null;
    },
    async findByUser(userId) {
      const uid = String(userId);
      return [...byId.values()].filter((r) => r.userId === uid).map(clone);
    },
    async update(capabilityId, patch) {
      const key = String(capabilityId);
      const existing = byId.get(key);
      if (!existing) throw new CapabilityNotFoundError("Capability set not found", { details: { capabilityId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(key, clone(updated));
      idByDevice.set(capabilityKey(updated.userId, updated.deviceId), key);
      return clone(updated);
    },
    async delete(capabilityId) {
      const key = String(capabilityId);
      const existing = byId.get(key);
      if (existing) idByDevice.delete(capabilityKey(existing.userId, existing.deviceId));
      return byId.delete(key);
    },
    async listByState(state) {
      return [...byId.values()].filter((r) => r.state === state).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()]
        .filter((r) => LIVE.has(r.state) && r.expiresAt && new Date(r.expiresAt).getTime() <= now)
        .map(clone);
    },
    async countByState() {
      const counts = {};
      for (const r of byId.values()) counts[r.state] = (counts[r.state] ?? 0) + 1;
      return counts;
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  const negotiations = {
    async record(negotiation) {
      negotiationsById.set(negotiation.negotiationId, clone(negotiation));
      return clone(negotiation);
    },
    async findById(negotiationId) {
      const n = negotiationsById.get(String(negotiationId));
      return n ? clone(n) : null;
    },
    async listByDevice(userId, deviceId, options = {}) {
      const uid = String(userId);
      const did = String(deviceId);
      const list = [...negotiationsById.values()]
        .filter((n) => (n.requester === uid && n.requesterDevice === did) || (n.targetUser === uid && n.targetDevice === did))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listByPair(userId, deviceId, targetUser, targetDevice, options = {}) {
      const match = (n) =>
        (n.requester === String(userId) && n.requesterDevice === String(deviceId) && n.targetUser === String(targetUser) && n.targetDevice === String(targetDevice)) ||
        (n.requester === String(targetUser) && n.requesterDevice === String(targetDevice) && n.targetUser === String(userId) && n.targetDevice === String(deviceId));
      const list = [...negotiationsById.values()].filter(match).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listAll() {
      return [...negotiationsById.values()].map(clone);
    },
  };

  return {
    capabilities,
    negotiations,
    reset: () => {
      byId.clear();
      idByDevice.clear();
      negotiationsById.clear();
    },
  };
}

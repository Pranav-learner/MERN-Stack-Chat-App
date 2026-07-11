/**
 * @module peer-discovery/repository/inMemory
 *
 * In-memory Discovery repositories: the reference for the repository contract and the
 * test/device backend. Bundles the two stores the framework needs:
 *
 * - `sessions` — discovery-session records (register, lookup, update state, history,
 *   expiration sweep, per-requester + per-state listing).
 * - `registry` — discoverable device descriptors (upsert, per-user lookup, removal).
 *
 * Records are deep-copied on the way in and out. Imports no driver, so the whole stack
 * runs under `node --test`.
 *
 * ## Session store contract (shared with Mongo)
 * - `create(session) -> session`
 * - `findById(discoveryId) -> session | null`
 * - `update(discoveryId, patch) -> session`
 * - `delete(discoveryId) -> boolean`
 * - `findActiveByDedupeKey(key) -> session | null`  (dedupe of in-flight lookups)
 * - `listByRequester(requester, { activeOnly }) -> session[]`
 * - `listByState(state) -> session[]`
 * - `listExpired(nowIso) -> session[]`  (active sessions past their TTL)
 *
 * ## Registry store contract (shared with Mongo)
 * - `upsert(descriptor) -> descriptor`  (idempotent by userId+deviceId)
 * - `findByUser(userId) -> descriptor[]`
 * - `findByUserAndDevice(userId, deviceId) -> descriptor | null`
 * - `remove(userId, deviceId) -> boolean`
 * - `removeByUser(userId) -> number`
 * - `listAll() -> descriptor[]`
 */

import { DiscoveryNotFoundError } from "../errors.js";
import { ACTIVE_DISCOVERY_STATES } from "../types/types.js";
import { discoveryDedupeKey } from "../session/discoverySession.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_DISCOVERY_STATES);

/** @returns {{ sessions: object, registry: object, reset: () => void }} */
export function createInMemoryDiscoveryRepository() {
  /** @type {Map<string, object>} discoveryId -> session */
  const sessionsById = new Map();
  /** @type {Map<string, object>} `${userId}|${deviceId}` -> descriptor */
  const registryByKey = new Map();

  const sessions = {
    async create(session) {
      sessionsById.set(session.discoveryId, clone(session));
      return clone(session);
    },
    async findById(discoveryId) {
      const s = sessionsById.get(String(discoveryId));
      return s ? clone(s) : null;
    },
    async update(discoveryId, patch) {
      const key = String(discoveryId);
      const existing = sessionsById.get(key);
      if (!existing) throw new DiscoveryNotFoundError("Discovery session not found", { details: { discoveryId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      sessionsById.set(key, clone(updated));
      return clone(updated);
    },
    async delete(discoveryId) {
      return sessionsById.delete(String(discoveryId));
    },
    async findActiveByDedupeKey(dedupeKey) {
      for (const s of sessionsById.values()) {
        if (!ACTIVE.has(s.state)) continue;
        if (discoveryDedupeKey(s) === dedupeKey) return clone(s);
      }
      return null;
    },
    async listByRequester(requester, options = {}) {
      const rid = String(requester);
      return [...sessionsById.values()]
        .filter((s) => s.requester === rid && (!options.activeOnly || ACTIVE.has(s.state)))
        .map(clone);
    },
    async listByState(state) {
      return [...sessionsById.values()].filter((s) => s.state === state).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...sessionsById.values()]
        .filter((s) => ACTIVE.has(s.state) && s.expiresAt && new Date(s.expiresAt).getTime() <= now)
        .map(clone);
    },
  };

  const rkey = (userId, deviceId) => `${userId}|${deviceId}`;

  const registry = {
    async upsert(descriptor) {
      const key = rkey(descriptor.userId, descriptor.deviceId);
      const existing = registryByKey.get(key);
      const merged = existing
        ? { ...existing, ...descriptor, version: (existing.version ?? 0) + 1, registeredAt: existing.registeredAt }
        : descriptor;
      registryByKey.set(key, clone(merged));
      return clone(merged);
    },
    async findByUser(userId) {
      const uid = String(userId);
      return [...registryByKey.values()].filter((d) => d.userId === uid).map(clone);
    },
    async findByUserAndDevice(userId, deviceId) {
      const d = registryByKey.get(rkey(String(userId), String(deviceId)));
      return d ? clone(d) : null;
    },
    async remove(userId, deviceId) {
      return registryByKey.delete(rkey(String(userId), String(deviceId)));
    },
    async removeByUser(userId) {
      const uid = String(userId);
      let count = 0;
      for (const [k, d] of registryByKey) {
        if (d.userId === uid) {
          registryByKey.delete(k);
          count++;
        }
      }
      return count;
    },
    async listAll() {
      return [...registryByKey.values()].map(clone);
    },
  };

  return {
    sessions,
    registry,
    reset: () => {
      sessionsById.clear();
      registryByKey.clear();
    },
  };
}

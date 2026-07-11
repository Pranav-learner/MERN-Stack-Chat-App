/**
 * @module network-discovery/repository/inMemory
 *
 * In-memory Network Discovery repositories: the reference for the repository contract and the
 * test/device backend. Bundles two stores:
 *
 * - `profiles` — the current network profile per device (candidates are embedded in the profile).
 * - `history` — an append-only profile/candidate history (diagnostics + change tracking).
 *
 * Records are deep-copied on the way in and out. Imports no driver, so the whole stack runs under
 * `node --test`.
 *
 * ## Profile store contract (shared with Mongo)
 * - `create(profile) -> profile` · `findById(profileId) -> profile | null`
 * - `findByDevice(deviceId) -> profile | null` (the current profile) · `update(profileId, patch) -> profile`
 * - `delete(profileId) -> boolean` · `listByUser(userId) -> profile[]` · `listExpired(nowIso) -> profile[]`
 *
 * ## History store contract (shared with Mongo)
 * - `record(snapshot) -> snapshot` · `listByDevice(deviceId, { limit }) -> snapshot[]`
 */

import { ProfileNotFoundError } from "../errors.js";
import { ProfileState } from "../types/types.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const LIVE = new Set([ProfileState.DISCOVERING, ProfileState.READY]);

/** @returns {{ profiles: object, history: object, reset: () => void }} */
export function createInMemoryDiscoveryRepository() {
  /** @type {Map<string, object>} profileId -> profile */
  const byId = new Map();
  /** @type {Map<string, string>} deviceId -> current profileId */
  const currentByDevice = new Map();
  /** @type {object[]} history snapshots */
  const historyLog = [];

  const profiles = {
    async create(profile) {
      byId.set(profile.profileId, clone(profile));
      currentByDevice.set(String(profile.deviceId), profile.profileId);
      return clone(profile);
    },
    async findById(profileId) {
      const p = byId.get(String(profileId));
      return p ? clone(p) : null;
    },
    async findByDevice(deviceId) {
      // Return the device's CURRENT LIVE profile only (matches the Mongo backend, which filters on
      // live states). A profile that has been expired/staled/failed drops out.
      const id = currentByDevice.get(String(deviceId));
      const p = id ? byId.get(id) : null;
      if (!p || !LIVE.has(p.state)) return null;
      return clone(p);
    },
    async update(profileId, patch) {
      const key = String(profileId);
      const existing = byId.get(key);
      if (!existing) throw new ProfileNotFoundError("Network profile not found", { details: { profileId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(key, clone(updated));
      if (LIVE.has(updated.state)) currentByDevice.set(String(updated.deviceId), key);
      return clone(updated);
    },
    async delete(profileId) {
      const key = String(profileId);
      const existing = byId.get(key);
      if (existing && currentByDevice.get(String(existing.deviceId)) === key) currentByDevice.delete(String(existing.deviceId));
      return byId.delete(key);
    },
    async listByUser(userId) {
      const uid = String(userId);
      return [...byId.values()].filter((p) => p.userId === uid).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()]
        .filter((p) => LIVE.has(p.state) && p.expiresAt && new Date(p.expiresAt).getTime() <= now)
        .map(clone);
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  const history = {
    async record(snapshot) {
      historyLog.push(clone(snapshot));
      return clone(snapshot);
    },
    async listByDevice(deviceId, options = {}) {
      const did = String(deviceId);
      const list = historyLog.filter((s) => s.deviceId === did).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  return {
    profiles,
    history,
    reset: () => {
      byId.clear();
      currentByDevice.clear();
      historyLog.length = 0;
    },
  };
}

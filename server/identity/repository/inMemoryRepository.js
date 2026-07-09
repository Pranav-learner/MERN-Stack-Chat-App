/**
 * @module identity/repository/inMemory
 *
 * In-memory implementation of the identity & device repositories. Used by the
 * test suite (no MongoDB required) and as a reference for the repository
 * contract. Records are deep-copied in and out so stored state is isolated.
 *
 * ## Repository contract (shared with the Mongo implementation)
 *
 * `IdentityRepository`:
 * - `create(record) -> record`  (throws {@link DuplicateIdentityError} if the user already has one)
 * - `findByUser(userId) -> record | null`
 * - `findById(identityId) -> record | null`
 * - `findByFingerprint(fingerprint) -> record | null`
 * - `update(identityId, patch) -> record`  (throws {@link IdentityNotFoundError})
 * - `delete(identityId) -> boolean`  (future-safe)
 *
 * `DeviceRepository`:
 * - `create(record) -> record`  (throws {@link DuplicateDeviceError} on id clash)
 * - `findById(deviceId) -> record | null`
 * - `findByIdentity(identityId) -> record[]`
 * - `findByUser(userId) -> record[]`
 * - `update(deviceId, patch) -> record`  (throws {@link DeviceNotFoundError})
 * - `delete(deviceId) -> boolean`
 */

import {
  DuplicateDeviceError,
  DuplicateIdentityError,
  DeviceNotFoundError,
  IdentityNotFoundError,
} from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/**
 * Create fresh in-memory identity + device repositories.
 * @returns {{ identities: object, devices: object, reset: () => void }}
 */
export function createInMemoryRepositories() {
  /** @type {Map<string, object>} identityId -> record */
  const identityById = new Map();
  /** @type {Map<string, string>} userId -> identityId */
  const identityIdByUser = new Map();
  /** @type {Map<string, object>} deviceId -> record */
  const deviceById = new Map();

  const identities = {
    async create(record) {
      const userKey = String(record.user);
      if (identityIdByUser.has(userKey)) {
        throw new DuplicateIdentityError("User already has an identity", {
          details: { userId: userKey },
        });
      }
      identityById.set(record.identityId, clone(record));
      identityIdByUser.set(userKey, record.identityId);
      return clone(record);
    },
    async findByUser(userId) {
      const id = identityIdByUser.get(String(userId));
      return id ? clone(identityById.get(id)) : null;
    },
    async findById(identityId) {
      return identityById.has(identityId) ? clone(identityById.get(identityId)) : null;
    },
    async findByFingerprint(fingerprint) {
      for (const rec of identityById.values()) {
        if (rec.fingerprint === fingerprint) return clone(rec);
      }
      return null;
    },
    async update(identityId, patch) {
      const existing = identityById.get(identityId);
      if (!existing) throw new IdentityNotFoundError("Identity not found", { details: { identityId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      identityById.set(identityId, clone(updated));
      return clone(updated);
    },
    async delete(identityId) {
      const existing = identityById.get(identityId);
      if (!existing) return false;
      identityById.delete(identityId);
      identityIdByUser.delete(String(existing.user));
      return true;
    },
  };

  const devices = {
    async create(record) {
      if (deviceById.has(record.deviceId)) {
        throw new DuplicateDeviceError("Device already exists", {
          details: { deviceId: record.deviceId },
        });
      }
      deviceById.set(record.deviceId, clone(record));
      return clone(record);
    },
    async findById(deviceId) {
      return deviceById.has(deviceId) ? clone(deviceById.get(deviceId)) : null;
    },
    async findByIdentity(identityId) {
      return [...deviceById.values()].filter((d) => d.identityId === identityId).map(clone);
    },
    async findByUser(userId) {
      return [...deviceById.values()].filter((d) => String(d.user) === String(userId)).map(clone);
    },
    async update(deviceId, patch) {
      const existing = deviceById.get(deviceId);
      if (!existing) throw new DeviceNotFoundError("Device not found", { details: { deviceId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      deviceById.set(deviceId, clone(updated));
      return clone(updated);
    },
    async delete(deviceId) {
      return deviceById.delete(deviceId);
    },
  };

  const reset = () => {
    identityById.clear();
    identityIdByUser.clear();
    deviceById.clear();
  };

  return { identities, devices, reset };
}

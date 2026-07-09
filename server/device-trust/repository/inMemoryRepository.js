/**
 * @module device-trust/repository/inMemory
 *
 * In-memory device repository for tests and as the reference for the repository
 * contract. Records are deep-copied in and out so storage is isolated.
 *
 * ## Repository contract (shared with the Mongo implementation)
 * - `create(record) -> record`            (throws {@link DuplicateDeviceError})
 * - `findById(deviceId) -> record | null`
 * - `findByUser(userId) -> record[]`
 * - `findByIdentity(identityId) -> record[]`
 * - `findByStatus(userId, trustStatus) -> record[]`
 * - `findTrusted(userId) -> record[]`
 * - `countByUser(userId) -> number`
 * - `update(deviceId, patch) -> record`   (throws {@link DeviceNotFoundError})
 * - `delete(deviceId) -> boolean`
 */

import { DuplicateDeviceError, DeviceNotFoundError } from "../errors.js";
import { TrustStatus } from "../types.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/**
 * Create a fresh in-memory device repository.
 * @returns {{ devices: object, reset: () => void }}
 */
export function createInMemoryDeviceRepository() {
  /** @type {Map<string, object>} deviceId -> record */
  const byId = new Map();

  const devices = {
    async create(record) {
      if (byId.has(record.deviceId)) {
        throw new DuplicateDeviceError("Device already exists", {
          details: { deviceId: record.deviceId },
        });
      }
      byId.set(record.deviceId, clone(record));
      return clone(record);
    },
    async findById(deviceId) {
      return byId.has(deviceId) ? clone(byId.get(deviceId)) : null;
    },
    async findByUser(userId) {
      return [...byId.values()].filter((d) => String(d.user) === String(userId)).map(clone);
    },
    async findByIdentity(identityId) {
      return [...byId.values()].filter((d) => d.identityId === identityId).map(clone);
    },
    async findByStatus(userId, trustStatus) {
      return [...byId.values()]
        .filter((d) => String(d.user) === String(userId) && d.trustStatus === trustStatus)
        .map(clone);
    },
    async findTrusted(userId) {
      return devices.findByStatus(userId, TrustStatus.TRUSTED);
    },
    async countByUser(userId) {
      return (await devices.findByUser(userId)).length;
    },
    async update(deviceId, patch) {
      const existing = byId.get(deviceId);
      if (!existing) throw new DeviceNotFoundError("Device not found", { details: { deviceId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(deviceId, clone(updated));
      return clone(updated);
    },
    async delete(deviceId) {
      return byId.delete(deviceId);
    },
  };

  return { devices, reset: () => byId.clear() };
}

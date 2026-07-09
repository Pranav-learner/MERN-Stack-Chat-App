/**
 * @module device-trust/repository/mongo
 *
 * MongoDB (Mongoose) device repository. Operates on the SAME `devices` collection
 * / `Device` model introduced in Sprint 1 (now additively extended with trust
 * fields), so identity and device-trust share one source of truth. Mirrors the
 * contract in {@link module:device-trust/repository/inMemory}.
 */

import Device from "../../identity/models/Device.model.js";
import { DuplicateDeviceError, DeviceNotFoundError } from "../errors.js";
import { TrustStatus } from "../types.js";

/**
 * Build a Mongo-backed device repository.
 * @param {{ DeviceModel?: import("mongoose").Model }} [models]
 * @returns {{ devices: object }}
 */
export function createMongoDeviceRepository(models = {}) {
  const DeviceModel = models.DeviceModel ?? Device;

  const devices = {
    async create(record) {
      try {
        const doc = await DeviceModel.create(record);
        return doc.toObject();
      } catch (err) {
        if (err && err.code === 11000) {
          throw new DuplicateDeviceError("Device already exists", { cause: err });
        }
        throw err;
      }
    },
    async findById(deviceId) {
      return DeviceModel.findOne({ deviceId }).lean();
    },
    async findByUser(userId) {
      return DeviceModel.find({ user: userId }).lean();
    },
    async findByIdentity(identityId) {
      return DeviceModel.find({ identityId }).lean();
    },
    async findByStatus(userId, trustStatus) {
      return DeviceModel.find({ user: userId, trustStatus }).lean();
    },
    async findTrusted(userId) {
      return DeviceModel.find({ user: userId, trustStatus: TrustStatus.TRUSTED }).lean();
    },
    async countByUser(userId) {
      return DeviceModel.countDocuments({ user: userId });
    },
    async update(deviceId, patch) {
      const updated = await DeviceModel.findOneAndUpdate({ deviceId }, patch, { new: true }).lean();
      if (!updated) throw new DeviceNotFoundError("Device not found", { details: { deviceId } });
      return updated;
    },
    async delete(deviceId) {
      const res = await DeviceModel.deleteOne({ deviceId });
      return res.deletedCount > 0;
    },
  };

  return { devices };
}

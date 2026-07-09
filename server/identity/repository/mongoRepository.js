/**
 * @module identity/repository/mongo
 *
 * MongoDB (Mongoose) implementation of the identity & device repositories. Mirrors
 * the contract documented in {@link module:identity/repository/inMemory}, so the
 * {@link IdentityManager} works against either backend unchanged.
 *
 * All reads use `.lean()` to return plain objects (never Mongoose documents that
 * could accidentally serialize internal fields).
 */

import Identity from "../models/Identity.model.js";
import Device from "../models/Device.model.js";
import {
  DuplicateDeviceError,
  DuplicateIdentityError,
  DeviceNotFoundError,
  IdentityNotFoundError,
} from "../errors.js";

/**
 * Build Mongo-backed repositories.
 * @param {{ IdentityModel?: import("mongoose").Model, DeviceModel?: import("mongoose").Model }} [models]
 * @returns {{ identities: object, devices: object }}
 */
export function createMongoRepositories(models = {}) {
  const IdentityModel = models.IdentityModel ?? Identity;
  const DeviceModel = models.DeviceModel ?? Device;

  const identities = {
    async create(record) {
      try {
        const doc = await IdentityModel.create(record);
        return doc.toObject();
      } catch (err) {
        if (err && err.code === 11000) {
          throw new DuplicateIdentityError("User already has an identity", { cause: err });
        }
        throw err;
      }
    },
    async findByUser(userId) {
      return IdentityModel.findOne({ user: userId }).lean();
    },
    async findById(identityId) {
      return IdentityModel.findOne({ identityId }).lean();
    },
    async findByFingerprint(fingerprint) {
      return IdentityModel.findOne({ fingerprint }).lean();
    },
    async update(identityId, patch) {
      const updated = await IdentityModel.findOneAndUpdate({ identityId }, patch, {
        new: true,
      }).lean();
      if (!updated) throw new IdentityNotFoundError("Identity not found", { details: { identityId } });
      return updated;
    },
    async delete(identityId) {
      const res = await IdentityModel.deleteOne({ identityId });
      return res.deletedCount > 0;
    },
  };

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
    async findByIdentity(identityId) {
      return DeviceModel.find({ identityId }).lean();
    },
    async findByUser(userId) {
      return DeviceModel.find({ user: userId }).lean();
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

  return { identities, devices };
}

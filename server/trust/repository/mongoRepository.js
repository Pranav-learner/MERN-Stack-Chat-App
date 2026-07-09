/**
 * @module trust/repository/mongo
 *
 * MongoDB (Mongoose) trust repositories. Mirrors the contract in
 * {@link module:trust/repository/inMemory}. Reads use `.lean()`.
 */

import Verification from "../models/Verification.model.js";
import IdentityChange from "../models/IdentityChange.model.js";
import { VerificationNotFoundError } from "../errors.js";

/**
 * @param {{ VerificationModel?: import("mongoose").Model, IdentityChangeModel?: import("mongoose").Model }} [models]
 * @returns {{ verifications: object, changes: object }}
 */
export function createMongoTrustRepositories(models = {}) {
  const VerificationModel = models.VerificationModel ?? Verification;
  const IdentityChangeModel = models.IdentityChangeModel ?? IdentityChange;

  const verifications = {
    async create(record) {
      const doc = await VerificationModel.create(record);
      return doc.toObject();
    },
    async findByPair(verifierUser, subjectUser) {
      return VerificationModel.findOne({ verifierUser, subjectUser }).lean();
    },
    async findById(verificationId) {
      return VerificationModel.findOne({ verificationId }).lean();
    },
    async findByVerifier(verifierUser) {
      return VerificationModel.find({ verifierUser }).lean();
    },
    async findBySubject(subjectUser) {
      return VerificationModel.find({ subjectUser }).lean();
    },
    async update(verificationId, patch) {
      const updated = await VerificationModel.findOneAndUpdate({ verificationId }, patch, { new: true }).lean();
      if (!updated) throw new VerificationNotFoundError("Verification not found", { details: { verificationId } });
      return updated;
    },
    async delete(verificationId) {
      const res = await VerificationModel.deleteOne({ verificationId });
      return res.deletedCount > 0;
    },
  };

  const changes = {
    async create(record) {
      const doc = await IdentityChangeModel.create(record);
      return doc.toObject();
    },
    async findBySubject(subjectUser) {
      return IdentityChangeModel.find({ subjectUser }).sort({ detectedAt: 1 }).lean();
    },
  };

  return { verifications, changes };
}

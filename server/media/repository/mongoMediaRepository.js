/**
 * @module media/repository/mongoMediaRepository
 *
 * MongoDB repository with automatic in-memory fallback for Layer 11 media metadata.
 */

import mongoose from "mongoose";
import { createInMemoryMediaRepository } from "./inMemoryMediaRepository.js";

const isConnected = () => mongoose.connection?.readyState === 1;

export function createMongoMediaRepository() {
  const fallback = createInMemoryMediaRepository();

  return {
    mediaRepo: {
      async create(doc) {
        if (!isConnected()) return fallback.mediaRepo.create(doc);
        try {
          const MediaMetadata = mongoose.models.MediaMetadata;
          if (!MediaMetadata) return fallback.mediaRepo.create(doc);
          const record = await MediaMetadata.create(doc);
          return record.toObject();
        } catch {
          return fallback.mediaRepo.create(doc);
        }
      },

      async findById(mediaId) {
        if (!isConnected()) return fallback.mediaRepo.findById(mediaId);
        try {
          const MediaMetadata = mongoose.models.MediaMetadata;
          if (!MediaMetadata) return fallback.mediaRepo.findById(mediaId);
          const hit = await MediaMetadata.findOne({ mediaId: String(mediaId) }).lean();
          return hit ?? fallback.mediaRepo.findById(mediaId);
        } catch {
          return fallback.mediaRepo.findById(mediaId);
        }
      },

      async update(mediaId, updates) {
        if (!isConnected()) return fallback.mediaRepo.update(mediaId, updates);
        try {
          const MediaMetadata = mongoose.models.MediaMetadata;
          if (!MediaMetadata) return fallback.mediaRepo.update(mediaId, updates);
          const updated = await MediaMetadata.findOneAndUpdate({ mediaId: String(mediaId) }, { $set: updates }, { new: true }).lean();
          return updated ?? fallback.mediaRepo.update(mediaId, updates);
        } catch {
          return fallback.mediaRepo.update(mediaId, updates);
        }
      },

      async delete(mediaId) {
        if (!isConnected()) return fallback.mediaRepo.delete(mediaId);
        try {
          const MediaMetadata = mongoose.models.MediaMetadata;
          if (!MediaMetadata) return fallback.mediaRepo.delete(mediaId);
          const res = await MediaMetadata.deleteOne({ mediaId: String(mediaId) });
          return res.deletedCount > 0;
        } catch {
          return fallback.mediaRepo.delete(mediaId);
        }
      },

      async list(query = {}) {
        if (!isConnected()) return fallback.mediaRepo.list(query);
        try {
          const MediaMetadata = mongoose.models.MediaMetadata;
          if (!MediaMetadata) return fallback.mediaRepo.list(query);
          const filter = {};
          if (query.ownerId) filter.ownerId = query.ownerId;
          if (query.state) filter.state = query.state;
          const limit = query.limit ?? 50;
          const docs = await MediaMetadata.find(filter).limit(limit).lean();
          return docs.length > 0 ? docs : fallback.mediaRepo.list(query);
        } catch {
          return fallback.mediaRepo.list(query);
        }
      },

      async count() {
        if (!isConnected()) return fallback.mediaRepo.count();
        try {
          const MediaMetadata = mongoose.models.MediaMetadata;
          if (!MediaMetadata) return fallback.mediaRepo.count();
          return await MediaMetadata.countDocuments();
        } catch {
          return fallback.mediaRepo.count();
        }
      },
    },

    operationRepo: fallback.operationRepo,
    integrityRepo: fallback.integrityRepo,
  };
}

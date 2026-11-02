/**
 * @module media/models/MediaMetadata
 *
 * Mongoose model for control-plane media metadata (no ciphertext, no keys).
 */

import mongoose from "mongoose";

const mediaMetadataSchema = new mongoose.Schema(
  {
    mediaId: { type: String, required: true, unique: true, index: true },
    ownerId: { type: String, required: true, index: true },
    conversationId: { type: String, index: true },
    groupId: { type: String, index: true },
    filename: { type: String, default: "file.bin" },
    contentType: { type: String, default: "application/octet-stream" },
    plaintextSize: { type: Number, default: 0 },
    plaintextHash: { type: String, required: true },
    ciphertextHash: { type: String },
    ciphertextSize: { type: Number, default: 0 },
    encryption: {
      keyFingerprint: { type: String, required: true },
      iv: { type: String, required: true },
      authTag: { type: String, required: true },
    },
    state: { type: String, default: "available", enum: ["available", "deleted", "corrupted"] },
  },
  { timestamps: true }
);

const MediaMetadata = mongoose.models.MediaMetadata || mongoose.model("MediaMetadata", mediaMetadataSchema);

export default MediaMetadata;

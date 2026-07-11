/**
 * @module transport-engine/models/TransferChunk
 *
 * Mongoose schema for a single payload FRAGMENT (Layer 8, Sprint 2). NEW collection; additive. Stores
 * the OPAQUE ciphertext fragment (`data`, base64) + its position + an integrity checksum.
 *
 * @security `data` is a slice of the crypto layer's ciphertext — never plaintext. `checksum` is an
 * integrity hash over those ciphertext bytes, not key material. There is no plaintext/key field.
 */

import mongoose from "mongoose";

const transferChunkSchema = new mongoose.Schema(
  {
    chunkId: { type: String, required: true, unique: true, index: true },
    transferId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    index: { type: Number, required: true },
    total: { type: Number, required: true },
    offset: { type: Number, required: true },
    size: { type: Number, required: true },
    data: { type: String, required: true }, // OPAQUE ciphertext fragment (base64)
    checksum: { type: String, required: true },
    state: { type: String, enum: ["pending", "scheduled", "sent", "acked", "received", "failed"], required: true, index: true },
    retryCount: { type: Number, default: 0 },
    nextRetryAt: { type: String, default: null, index: true },
    priority: { type: String, default: "file" },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

transferChunkSchema.index({ transferId: 1, index: 1 });
transferChunkSchema.index({ transferId: 1, state: 1, nextRetryAt: 1 });

const TransferChunk = mongoose.models.TransferChunk || mongoose.model("TransferChunk", transferChunkSchema);
export default TransferChunk;

/**
 * @module media-delivery/models/DeliveryTransfer
 *
 * Mongoose schema for a progressive transfer (Layer 11, Sprint 2). NEW collection (`deliverytransfers`);
 * additive. Tracks the transfer FSM + received-chunk recovery metadata + byte counts — control-plane
 * metadata only (no ciphertext or keys).
 */

import mongoose from "mongoose";

const deliveryTransferSchema = new mongoose.Schema(
  {
    transferId: { type: String, required: true, unique: true, index: true },
    mediaId: { type: String, required: true, index: true },
    direction: { type: String, required: true, index: true }, // download | upload
    deviceId: { type: String, required: true, index: true },
    ownerId: { type: String },
    contentType: { type: String, default: null },
    state: { type: String, default: "pending", index: true },
    priority: { type: String, default: "normal", index: true },
    chunkSize: { type: Number },
    chunkCount: { type: Number },
    deliveredChunks: { type: Number, default: 0 },
    bytesTotal: { type: Number, default: 0 },
    bytesTransferred: { type: Number, default: 0 },
    received: { type: [Number], default: [] },
    window: { type: Number },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

deliveryTransferSchema.index({ deviceId: 1, state: 1 });
deliveryTransferSchema.index({ mediaId: 1, direction: 1 });

const DeliveryTransfer = mongoose.models.DeliveryTransfer || mongoose.model("DeliveryTransfer", deliveryTransferSchema);
export default DeliveryTransfer;

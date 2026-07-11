/**
 * @module data-plane/models/AckRecord
 *
 * Mongoose schema for an acknowledgement history record (Layer 8, Sprint 1). NEW collection;
 * additive. One record per ACK sent/received (for diagnostics + duplicate-ACK detection audit).
 *
 * @security PUBLIC ACK metadata only — ids, types, timestamps. No plaintext / key material.
 */

import mongoose from "mongoose";

const ackRecordSchema = new mongoose.Schema(
  {
    ackId: { type: String, index: true },
    messageId: { type: String, required: true, index: true },
    conversationId: { type: String, index: true },
    ackType: { type: String },
    direction: { type: String, enum: ["sent", "received"], index: true },
    seq: { type: Number },
    at: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

ackRecordSchema.index({ conversationId: 1, at: -1 });

const AckRecord = mongoose.models.AckRecord || mongoose.model("AckRecord", ackRecordSchema);

export default AckRecord;

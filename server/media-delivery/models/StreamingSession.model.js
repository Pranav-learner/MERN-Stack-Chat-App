/**
 * @module media-delivery/models/StreamingSession
 *
 * Mongoose schema for a streaming session (Layer 11, Sprint 2). NEW collection (`streamingsessions`);
 * additive. Tracks the session FSM + chunk layout + buffer state — control-plane metadata only (chunk
 * indices + counts; no ciphertext or keys).
 */

import mongoose from "mongoose";

const streamingSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    mediaId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    ownerId: { type: String, index: true },
    contentType: { type: String, default: null },
    state: { type: String, default: "idle", index: true },
    chunkSize: { type: Number },
    chunkCount: { type: Number },
    totalBytes: { type: Number },
    cursor: { type: Number, default: 0 },
    buffered: { type: Number, default: -1 },
    bufferedChunks: { type: [Number], default: [] },
    bufferWindow: { type: [Number], default: [] },
    windowChunks: { type: Number },
    deliveredCount: { type: Number, default: 0 },
    seekCount: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

streamingSessionSchema.index({ deviceId: 1, createdAt: -1 });

const StreamingSession = mongoose.models.StreamingSession || mongoose.model("StreamingSession", streamingSessionSchema);
export default StreamingSession;

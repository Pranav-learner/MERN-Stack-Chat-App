/**
 * @module presence/models/PresenceRecord
 *
 * Mongoose schema for a device presence record (Layer 6, Sprint 2). NEW collection; additive —
 * it does NOT modify the existing User/Message/Group, the identity/device, or any
 * crypto-subsystem or discovery schema. One document per `(userId, deviceId)`.
 *
 * @security This collection stores presence CONTROL-PLANE metadata ONLY — ids, status,
 * timestamps, and a PUBLIC device advertisement (public identity key + fingerprint, platform,
 * software version). There is deliberately **NO field** for a private key, session key, message
 * key, chain key, or shared secret, and **no transport reachability** (a future sprint).
 */

import mongoose from "mongoose";

const presenceRecordSchema = new mongoose.Schema(
  {
    presenceId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    identityId: { type: String, default: null, index: true },
    deviceId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["online", "away", "busy", "invisible", "reconnecting", "disconnected", "offline", "expired", "unknown"],
      required: true,
      index: true,
    },
    registeredAt: { type: String },
    lastSeen: { type: String, index: true },
    heartbeatAt: { type: String },
    // Presence expires (heartbeat timeout) at this instant unless refreshed.
    expiresAt: { type: String, index: true },
    // PUBLIC device advertisement (identity + status + descriptive metadata) — no secrets.
    advertisement: { type: mongoose.Schema.Types.Mixed, default: null },
    version: { type: Number, default: 1 },
    statusHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    missedHeartbeats: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// One presence record per (user, device); primary lookups are by device + by user.
presenceRecordSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
// Accelerates "reachable devices of a user" and heartbeat-expiry sweeps.
presenceRecordSchema.index({ userId: 1, status: 1 });
presenceRecordSchema.index({ status: 1, expiresAt: 1 });

const PresenceRecord =
  mongoose.models.PresenceRecord || mongoose.model("PresenceRecord", presenceRecordSchema);

export default PresenceRecord;

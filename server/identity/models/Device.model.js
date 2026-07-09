/**
 * @module identity/models/Device
 *
 * Mongoose schema for a registered device belonging to an identity. Stores ONLY
 * the device's PUBLIC key. `deviceId` is client-generated and stable per install,
 * so the same device is recognized across logins. Designed for multiple devices
 * per identity (a future layer).
 *
 * This is a NEW collection; it does not modify existing schemas.
 */

import mongoose from "mongoose";

const deviceSchema = new mongoose.Schema(
  {
    /** Client-generated, stable-per-install device id. */
    deviceId: { type: String, required: true, unique: true, index: true },
    /** The identity this device belongs to. */
    identityId: { type: String, required: true, index: true },
    /** Owning user (denormalized for convenient lookup / ownership checks). */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** Human-friendly device name (e.g. "Pranav's Laptop"). */
    name: { type: String },
    /** Platform descriptor (e.g. "web (Chrome on Linux)"). */
    platform: { type: String },
    /** Base64 raw Ed25519 device public key. PUBLIC — never a private key. */
    publicKey: { type: String, required: true },
    algorithm: { type: String, required: true, default: "ed25519" },
    /** Canonical hex SHA-256 fingerprint of the device public key. */
    fingerprint: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
    },
    /** Last time the device was seen active. */
    lastActive: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

const Device = mongoose.models.Device || mongoose.model("Device", deviceSchema);

export default Device;

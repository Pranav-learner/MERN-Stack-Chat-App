/**
 * @module fabric-reliability/models/FabricHealthSnapshot
 *
 * Persisted **health snapshot** — a point-in-time record of overall + per-component Fabric health plus a
 * metrics digest, retained for operational history + trend inspection. Control-plane only: statuses +
 * numbers. No content/keys.
 */

import mongoose from "mongoose";

const FabricHealthSnapshotSchema = new mongoose.Schema(
  {
    status: { type: String, required: true, index: true },
    components: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metricsDigest: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
  },
  { timestamps: true, minimize: false },
);

export const FabricHealthSnapshotModel = mongoose.models.FabricHealthSnapshot || mongoose.model("FabricHealthSnapshot", FabricHealthSnapshotSchema);
export default FabricHealthSnapshotModel;

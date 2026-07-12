/**
 * @module fabric-reliability/models/FabricOperation
 *
 * Persisted **fabric operation checkpoint** — the recoverable record of a tracked fabric operation (id,
 * kind, state, attempt, opaque stage `data`, timestamps). Persisting it lets the recovery engine resume /
 * abandon operations left RUNNING after a crash / restart. Control-plane only: ids + stage markers + state.
 * No content/keys.
 */

import mongoose from "mongoose";

const FabricOperationSchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true, unique: true, index: true },
    kind: { type: String, required: true, index: true },
    state: { type: String, required: true, index: true },
    attempt: { type: Number, default: 1 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    ownerId: { type: String, default: null, index: true },
    startedAt: { type: String },
    updatedAt: { type: String },
  },
  { timestamps: true, minimize: false },
);

FabricOperationSchema.index({ state: 1, updatedAt: 1 });

export const FabricOperationModel = mongoose.models.FabricOperation || mongoose.model("FabricOperation", FabricOperationSchema);
export default FabricOperationModel;

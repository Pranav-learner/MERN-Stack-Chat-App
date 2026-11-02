import mongoose from "mongoose";

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    pendingMembers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    // Milestone 3 — Group End-to-End Encryption (Sender Keys)
    e2ee: {
      enabled: { type: Boolean, default: true },
      epoch: { type: Number, default: 1 },
      keyFingerprint: { type: String, default: "" },
      encryptedKeys: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          encryptedKey: { type: String, required: true },
          iv: { type: String, required: true },
          tag: { type: String, required: true },
          senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          epoch: { type: Number, default: 1 },
        },
      ],
    },
  },
  { timestamps: true }
);

const Group = mongoose.model("Group", groupSchema);

export default Group;

import Group from "../models/Group.model.js";
import Message from "../models/Message.model.js";
import { io } from "../lib/socket.js";
import { getUserSockets } from "../lib/redis.js";
import { relayManager } from "./secureTransportController.js";
import { toStoredCiphertext } from "../secure-transport/index.js";

export const createGroup = async (req, res) => {
  try {
    const { name, invitedUserIds, description } = req.body;
    const admin = req.user._id;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Group name is required" });
    }

    const newGroup = new Group({
      name: name.trim(),
      description: description ? description.trim() : "",
      admin,
      members: [admin], // Admin is automatically a member
      pendingMembers: Array.isArray(invitedUserIds) ? invitedUserIds : [],
    });

    await newGroup.save();

    // Populate group details so client receives consistent format
    let populatedGroup = newGroup;
    try {
      populatedGroup = await Group.findById(newGroup._id)
        .populate("members", "-password")
        .populate("pendingMembers", "-password")
        .populate("admin", "-password");
    } catch {
      populatedGroup = newGroup;
    }

    // Real-time broadcast to all invited users
    if (Array.isArray(invitedUserIds) && invitedUserIds.length > 0) {
      for (const uid of invitedUserIds) {
        try {
          const userSocketIds = await getUserSockets(uid);
          userSocketIds.forEach((sid) => {
            io.to(sid).emit("groupInvite", {
              group: populatedGroup,
              message: `You were invited to group "${newGroup.name}"!`,
            });
          });
        } catch (socketErr) {
          console.warn("Failed to emit groupInvite to user:", uid, socketErr?.message);
        }
      }
    }

    res.status(201).json({ success: true, group: populatedGroup });
  } catch (error) {
    console.error("Error in createGroup controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const inviteToGroup = async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    const requesterId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    // Verify requester is a member or admin
    const isMember = group.members.some((id) => id.toString() === requesterId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: "Only group members can invite others" });
    }

    // Check if user is already a member or pending
    if (
      group.members.some((id) => id.toString() === userId.toString()) ||
      group.pendingMembers.some((id) => id.toString() === userId.toString())
    ) {
      return res.status(400).json({ success: false, message: "User already invited or joined" });
    }

    group.pendingMembers.push(userId);
    await group.save();

    let populatedGroup = group;
    try {
      populatedGroup = await Group.findById(group._id)
        .populate("members", "-password")
        .populate("pendingMembers", "-password")
        .populate("admin", "-password");
    } catch {
      populatedGroup = group;
    }

    try {
      const userSocketIds = await getUserSockets(userId);
      userSocketIds.forEach((sid) => {
        io.to(sid).emit("groupInvite", {
          group: populatedGroup,
          message: `You were invited to group "${group.name}"!`,
        });
      });
    } catch (socketErr) {
      console.warn("Failed to emit groupInvite:", socketErr?.message);
    }

    res.status(200).json({ success: true, message: "User invited successfully", group: populatedGroup });
  } catch (error) {
    console.error("Error in inviteToGroup controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const acceptInvite = async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    if (!group.pendingMembers.some((id) => id.toString() === userId.toString())) {
      return res.status(400).json({ success: false, message: "No invitation found for this group" });
    }

    // Move from pending to members
    group.pendingMembers = group.pendingMembers.filter(
      (id) => id.toString() !== userId.toString()
    );
    group.members.push(userId);
    await group.save();

    let populatedGroup = group;
    try {
      populatedGroup = await Group.findById(group._id)
        .populate("members", "-password")
        .populate("pendingMembers", "-password")
        .populate("admin", "-password");
    } catch {
      populatedGroup = group;
    }

    // Broadcast update to all members
    for (const member of group.members) {
      try {
        const memberSockets = await getUserSockets(member);
        memberSockets.forEach((sid) => {
          io.to(sid).emit("groupUpdated", populatedGroup);
        });
      } catch {}
    }

    res.status(200).json({ success: true, message: "Invitation accepted", group: populatedGroup });
  } catch (error) {
    console.error("Error in acceptInvite controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const rejectInvite = async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    group.pendingMembers = group.pendingMembers.filter(
      (id) => id.toString() !== userId.toString()
    );
    await group.save();

    res.status(200).json({ success: true, message: "Invitation rejected" });
  } catch (error) {
    console.error("Error in rejectInvite controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const getMyGroups = async (req, res) => {
  try {
    const userId = req.user._id;
    // Find groups where user is member OR pending member
    const groups = await Group.find({
      $or: [{ members: userId }, { pendingMembers: userId }],
    })
      .populate("members", "-password")
      .populate("pendingMembers", "-password")
      .populate("admin", "-password");

    res.status(200).json({ success: true, groups });
  } catch (error) {
    console.error("Error in getMyGroups controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    // Authorization: only members may view group messages
    const isMember = group.members.some((id) => id.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: "Access denied: you are not a member of this group" });
    }

    // Bounded page size (default 50, max 100)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const filter = { groupId };
    if (req.query.before) {
      const beforeDate = new Date(req.query.before);
      if (!isNaN(beforeDate.getTime())) {
        filter.createdAt = { $lt: beforeDate };
      }
    }

    const rawMessages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .populate("senderId", "fullName profilePic");

    const hasMore = rawMessages.length > limit;
    const pageMessages = hasMore ? rawMessages.slice(0, limit) : rawMessages;

    // Return in chronological order (oldest to newest)
    const messages = [...pageMessages].reverse();
    const nextCursor =
      hasMore && messages.length > 0 ? messages[0].createdAt.toISOString() : null;

    res.status(200).json({
      success: true,
      messages,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error("Error in getGroupMessages controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const sendGroupMessage = async (req, res) => {
  try {
    const { text, image, securePayload, clientMessageId } = req.body;
    const { groupId } = req.params;
    const senderId = req.user._id;

    // Validate payload
    if (!securePayload && (!text || !text.trim()) && !image) {
      return res.status(400).json({ success: false, message: "Message must contain text or image" });
    }

    // Validate image size (5MB raw ≈ 7MB base64)
    if (image && typeof image === "string" && image.length > 7 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Image exceeds maximum allowed size of 5MB" });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    // Authorization: only members may post messages to the group
    const isMember = group.members.some((id) => id.toString() === senderId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: "Access denied: you cannot send messages to this group" });
    }

    // Idempotency check: if clientMessageId already sent to this group by this sender
    if (clientMessageId && typeof clientMessageId === "string") {
      const existing = await Message.findOne({ senderId, groupId, clientMessageId })
        .populate("senderId", "fullName profilePic");
      if (existing) {
        return res.status(200).json({ success: true, message: existing, duplicate: true });
      }
    }

    // === Milestone 3: End-to-End Encrypted Group Message path ===
    if (securePayload) {
      const { payload } = relayManager.relay(securePayload, { sessionId: req.body?.sessionId || groupId });
      const stored = toStoredCiphertext(payload, { senderId });
      const newMessage = new Message({
        senderId,
        groupId,
        status: "sent",
        clientMessageId: clientMessageId || undefined,
        secure: stored.secure,
        session: {
          sessionId: payload.sessionId,
          keyId: payload.keyId,
          secured: true,
          transportMode: "session",
          fallback: false,
        },
      });

      await newMessage.save();
      await newMessage.populate("senderId", "fullName profilePic");

      if (io) {
        io.to(groupId.toString()).emit("newMessage", newMessage);
      }

      return res.status(201).json({ success: true, message: newMessage, encrypted: true });
    }

    // === Plaintext fallback path ===
    let imageUrl = image || undefined;
    if (image && typeof image === "string" && image.startsWith("data:image")) {
      try {
        const cloudinary = (await import("../lib/cloudinary.js")).default;
        const upload = await cloudinary.uploader.upload(image);
        imageUrl = upload.secure_url;
      } catch (uploadErr) {
        console.error("Cloudinary upload failed for group message image:", uploadErr.message);
        return res.status(502).json({
          success: false,
          message: "Media storage service unavailable. Failed to upload image.",
        });
      }
    }

    const newMessage = new Message({
      senderId,
      groupId,
      text: text ? text.trim() : undefined,
      image: imageUrl,
      clientMessageId: clientMessageId || undefined,
    });

    await newMessage.save();

    // Populate sender for frontend display
    await newMessage.populate("senderId", "fullName profilePic");

    // Socket.io: Emit to the group room
    if (io) {
      io.to(groupId).emit("newMessage", newMessage);
    }

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error("Error in sendGroupMessage controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const leaveGroup = async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    group.members = group.members.filter(
      (id) => id.toString() !== userId.toString()
    );
    await group.save();

    res.status(200).json({ success: true, message: "Left group successfully" });
  } catch (error) {
    console.error("Error in leaveGroup controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const removeMember = async (req, res) => {
  try {
    const { groupId, memberId } = req.body;
    const requesterId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    // Only admin can remove members
    if (group.admin.toString() !== requesterId.toString()) {
      return res.status(403).json({ success: false, message: "Only group admin can remove members" });
    }

    group.members = group.members.filter(
      (id) => id.toString() !== memberId.toString()
    );
    await group.save();

    res.status(200).json({ success: true, message: "Member removed successfully" });
  } catch (error) {
    console.error("Error in removeMember controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// === Milestone 3: Group Key Distribution & Synchronization ===

export const getGroupKeys = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const isMember = group.members.some((id) => id.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: "Access denied: you are not a member of this group" });
    }

    return res.status(200).json({
      success: true,
      e2ee: group.e2ee || { enabled: true, epoch: 1, keyFingerprint: "", encryptedKeys: [] },
    });
  } catch (error) {
    console.error("Error in getGroupKeys:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const updateGroupKeys = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { epoch, keyFingerprint, encryptedKeys } = req.body;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const isMember = group.members.some((id) => id.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: "Access denied: you are not a member of this group" });
    }

    if (!group.e2ee) {
      group.e2ee = { enabled: true, epoch: 1, keyFingerprint: "", encryptedKeys: [] };
    }

    if (epoch) group.e2ee.epoch = epoch;
    if (keyFingerprint) group.e2ee.keyFingerprint = keyFingerprint;

    if (Array.isArray(encryptedKeys)) {
      for (const k of encryptedKeys) {
        const existingIdx = group.e2ee.encryptedKeys.findIndex(
          (item) => item.userId.toString() === k.userId.toString()
        );
        if (existingIdx !== -1) {
          group.e2ee.encryptedKeys[existingIdx] = {
            userId: k.userId,
            encryptedKey: k.encryptedKey,
            iv: k.iv,
            tag: k.tag,
            senderId: userId,
            epoch: epoch || group.e2ee.epoch,
          };
        } else {
          group.e2ee.encryptedKeys.push({
            userId: k.userId,
            encryptedKey: k.encryptedKey,
            iv: k.iv,
            tag: k.tag,
            senderId: userId,
            epoch: epoch || group.e2ee.epoch,
          });
        }
      }
    }

    await group.save();

    if (io) {
      io.to(groupId.toString()).emit("groupKeysUpdated", {
        groupId,
        epoch: group.e2ee.epoch,
        keyFingerprint: group.e2ee.keyFingerprint,
      });
    }

    return res.status(200).json({ success: true, e2ee: group.e2ee });
  } catch (error) {
    console.error("Error in updateGroupKeys:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};



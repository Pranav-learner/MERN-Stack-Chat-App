import Group from "../models/Group.model.js";
import Message from "../models/Message.model.js";
import User from "../models/User.model.js";
import { io } from "../server.js";

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

    res.status(201).json({ success: true, group: newGroup });
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

    res.status(200).json({ success: true, message: "User invited successfully" });
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

    res.status(200).json({ success: true, message: "Invitation accepted", group });
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

    const messages = await Message.find({ groupId }).populate("senderId", "fullName profilePic");
    res.status(200).json({ success: true, messages });
  } catch (error) {
    console.error("Error in getGroupMessages controller:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const sendGroupMessage = async (req, res) => {
  try {
    const { text, image } = req.body;
    const { groupId } = req.params;
    const senderId = req.user._id;

    // Validate payload
    if ((!text || !text.trim()) && !image) {
      return res.status(400).json({ success: false, message: "Message must contain text or image" });
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

    let imageUrl = image || undefined;
    if (image && typeof image === "string" && image.startsWith("data:image")) {
      try {
        const cloudinary = (await import("../lib/cloudinary.js")).default;
        const upload = await cloudinary.uploader.upload(image);
        imageUrl = upload.secure_url;
      } catch (uploadErr) {
        console.warn("Cloudinary upload failed for group message image:", uploadErr.message);
      }
    }

    const newMessage = new Message({
      senderId,
      groupId,
      text: text ? text.trim() : undefined,
      image: imageUrl,
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


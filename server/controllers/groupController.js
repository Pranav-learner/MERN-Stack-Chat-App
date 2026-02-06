import Group from "../models/Group.model.js";
import Message from "../models/Message.model.js";
import User from "../models/User.model.js";
import { io } from "../server.js";

export const createGroup = async (req, res) => {
// ... existing code ...
  try {
    const { name, invitedUserIds, description } = req.body;
    const admin = req.user._id;

    const newGroup = new Group({
      name,
      description,
      admin,
      members: [admin], // Admin is automatically a member
      pendingMembers: invitedUserIds || [],
    });

    await newGroup.save();

    res.status(201).json({ success: true, group: newGroup });
  } catch (error) {
    console.log("Error in createGroup controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const inviteToGroup = async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    const group = await Group.findById(groupId);

    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if user is already a member or pending
    if (group.members.includes(userId) || group.pendingMembers.includes(userId)) {
      return res.status(400).json({ message: "User already invited or joined" });
    }

    group.pendingMembers.push(userId);
    await group.save();

    res.status(200).json({ success: true, message: "User invited successfully" });
  } catch (error) {
    console.log("Error in inviteToGroup controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const acceptInvite = async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    if (!group.pendingMembers.includes(userId)) {
      return res.status(400).json({ message: "No invitation found for this group" });
    }

    // Move from pending to members
    group.pendingMembers = group.pendingMembers.filter(
      (id) => id.toString() !== userId.toString()
    );
    group.members.push(userId);
    await group.save();

    res.status(200).json({ success: true, message: "Invitation accepted", group });
  } catch (error) {
    console.log("Error in acceptInvite controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const rejectInvite = async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    group.pendingMembers = group.pendingMembers.filter(
      (id) => id.toString() !== userId.toString()
    );
    await group.save();

    res.status(200).json({ success: true, message: "Invitation rejected" });
  } catch (error) {
    console.log("Error in rejectInvite controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
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
    console.log("Error in getMyGroups controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;
    const messages = await Message.find({ groupId }).populate("senderId", "fullName profilePic");
    res.status(200).json({ success: true, messages });
  } catch (error) {
    console.log("Error in getGroupMessages controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const sendGroupMessage = async (req, res) => {
  try {
    const { text, image } = req.body;
    const { groupId } = req.params;
    const senderId = req.user._id;

    let imageUrl;
    if (image) {
      // Upload logic here if needed, consistent with existing sendMessage
      // For now assuming image is a URL or base64 handled elsewhere or matches existing logic
      imageUrl = image;
    }

    const newMessage = new Message({
      senderId,
      groupId,
      text,
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
    console.log("Error in sendGroupMessage controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};


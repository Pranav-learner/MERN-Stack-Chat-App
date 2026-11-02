import { createContext, useState, useContext, useEffect } from "react";
import { AuthContext } from "../context/AuthContext";
import toast from "react-hot-toast";
import {
  encryptDirectMessage,
  decryptDirectMessage,
  decryptMessageList,
  encryptMediaFile,
  uploadEncryptedMedia,
  cacheMediaUrl,
  fetchAndDecryptMedia,
  encryptGroupMessage,
  decryptGroupMessage,
  decryptGroupMessageList,
} from "../src/lib/e2eeService";

export const ChatContext = createContext();

export const ChatProvider = ({ children }) => {
  const [messages, setMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]); // [NEW]
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null); // [NEW]
  const [unseenMessages, setUnseenMessages] = useState({});

  const { socket, axios, authUser } = useContext(AuthContext);

  // function to get all users
  const getUsers = async () => {
    try {
      const { data } = await axios.get("api/messages/users");
      if (data.success) {
        setUsers(data.users);
        setUnseenMessages(data.unseenMessages);
      }
    } catch (error) {
      toast.error(error.message);
    }
  };

  // function to get my groups
  const fetchGroups = async () => {
    try {
      const { data } = await axios.get("/api/groups/my-groups");
      if (data.success) {
        setGroups(data.groups);
      }
    } catch (error) {
      toast.error(error.message);
    }
  };

  const getErrorMsg = (err) => err?.response?.data?.message || err?.message || "An error occurred";

  // function to create group
  const createGroup = async (name, invitedUserIds) => {
    try {
      const { data } = await axios.post("/api/groups/create", { name, invitedUserIds });
      if (data.success) {
        setGroups((prev) => [...prev, data.group]);
        socket?.emit("joinGroup", data.group._id);
        toast.success("Group created successfully");
        return true;
      }
    } catch (error) {
      toast.error(getErrorMsg(error));
      return false;
    }
  };

  const inviteToGroup = async (groupId, userId) => {
    try {
      const { data } = await axios.post("/api/groups/invite", { groupId, userId });
      if (data.success) toast.success(data.message);
    } catch (error) {
      toast.error(getErrorMsg(error));
    }
  };

  const acceptInvite = async (groupId) => {
    try {
      const { data } = await axios.post("/api/groups/accept", { groupId });
      if (data.success) {
        toast.success(data.message);
        socket?.emit("joinGroup", groupId);
        fetchGroups(); // refresh to update member status
      }
    } catch (error) {
      toast.error(getErrorMsg(error));
    }
  };

  const rejectInvite = async (groupId) => {
    try {
      const { data } = await axios.post("/api/groups/reject", { groupId });
      if (data.success) {
        toast.success(data.message);
        fetchGroups(); 
      }
    } catch (error) {
      toast.error(getErrorMsg(error));
    }
  };

  // function to messages of selected user OR group
  const getMessages = async (userId) => {
    setUnseenMessages((prev) => ({ ...prev, [userId]: 0 }));
    try {
      const { data } = await axios.get(`/api/messages/${userId}`);
      if (data.success) {
        const peer = selectedUser && selectedUser._id === userId ? selectedUser : users.find((u) => u._id === userId);
        const decryptedList = await decryptMessageList(data.messages, authUser?._id, peer, axios);
        setMessages(decryptedList);
      }
    } catch (error) {
      toast.error(getErrorMsg(error));
    }
  };

  const getGroupMessages = async (groupId) => {
    setUnseenMessages((prev) => ({ ...prev, [groupId]: 0 }));
    socket?.emit("joinGroup", groupId);
    try {
      const { data } = await axios.get(`/api/groups/${groupId}/messages`);
      if (data.success) {
        const currentGrp = (selectedGroup && selectedGroup._id === groupId)
          ? selectedGroup
          : groups.find((g) => g._id === groupId);
        const decryptedList = await decryptGroupMessageList(data.messages, authUser?._id, currentGrp, axios);
        setMessages(decryptedList);
      }
    } catch (error) {
      toast.error(getErrorMsg(error));
    }
  };

  // function to send message to selected user or group with idempotency key
  const sendMessage = async (messagePayload) => {
    try {
      const clientMessageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      if (selectedGroup) {
        let sendPayload = { ...messagePayload, clientMessageId };
        let wasEncrypted = false;
        let displayedImage = messagePayload.image;

        try {
          let preparedPayload = { text: messagePayload.text };

          if (messagePayload.file) {
            const encryptedMedia = await encryptMediaFile(messagePayload.file);
            const mediaDoc = await uploadEncryptedMedia(axios, encryptedMedia, null);

            if (displayedImage) {
              cacheMediaUrl(mediaDoc.mediaId, displayedImage);
            }

            preparedPayload.media = {
              mediaId: mediaDoc.mediaId,
              mediaKey: encryptedMedia.mediaKeyB64,
              iv: encryptedMedia.ivB64,
              authTag: encryptedMedia.authTagB64,
              filename: encryptedMedia.filename,
              contentType: encryptedMedia.contentType,
              size: encryptedMedia.plaintextSize,
              plaintextHash: encryptedMedia.plaintextHash,
            };
          } else if (messagePayload.image) {
            preparedPayload.image = messagePayload.image;
          }

          const encryptedGroupRes = await encryptGroupMessage(
            selectedGroup._id,
            preparedPayload,
            authUser?._id,
            selectedGroup,
            axios
          );

          if (encryptedGroupRes?.securePayload) {
            sendPayload = {
              securePayload: encryptedGroupRes.securePayload,
              sessionId: encryptedGroupRes.sessionId,
              clientMessageId,
            };
            wasEncrypted = true;
          }
        } catch (encGroupErr) {
          console.warn("[e2ee] Group encryption error, sending via fallback:", encGroupErr);
        }

        const { data } = await axios.post(`/api/groups/send/${selectedGroup._id}`, sendPayload);
        if (data.success) {
          const displayedMessage = wasEncrypted
            ? {
                ...data.message,
                text: messagePayload.text,
                image: displayedImage,
                isEncrypted: true,
              }
            : data.message;

          setMessages((prevMessages) => {
            if (prevMessages.some((m) => m._id === data.message._id || (m.clientMessageId && m.clientMessageId === data.message.clientMessageId))) {
              return prevMessages;
            }
            return [...prevMessages, displayedMessage];
          });
        } else {
          toast.error(data.message);
        }
      } else if (selectedUser) {
        // Milestone 1 & 2 — Attempt End-to-End Encryption (Direct Message & Media)
        let sendPayload = { ...messagePayload, clientMessageId };
        let wasEncrypted = false;
        let displayedImage = messagePayload.image;

        if (selectedUser.publicKey && authUser?._id) {
          try {
            let preparedPayload = { text: messagePayload.text };

            // Milestone 2 — Encrypt media file via Layer 11 Secure Media Platform
            if (messagePayload.file) {
              const encryptedMedia = await encryptMediaFile(messagePayload.file);
              const mediaDoc = await uploadEncryptedMedia(axios, encryptedMedia, selectedUser._id);

              if (displayedImage) {
                cacheMediaUrl(mediaDoc.mediaId, displayedImage);
              }

              // Embed encrypted media key & metadata references inside E2EE direct message
              preparedPayload.media = {
                mediaId: mediaDoc.mediaId,
                mediaKey: encryptedMedia.mediaKeyB64,
                iv: encryptedMedia.ivB64,
                authTag: encryptedMedia.authTagB64,
                filename: encryptedMedia.filename,
                contentType: encryptedMedia.contentType,
                size: encryptedMedia.plaintextSize,
                plaintextHash: encryptedMedia.plaintextHash,
              };
            } else if (messagePayload.image) {
              preparedPayload.image = messagePayload.image;
            }

            const encryptedResult = await encryptDirectMessage(selectedUser, preparedPayload, authUser._id);
            if (encryptedResult?.securePayload) {
              sendPayload = {
                securePayload: encryptedResult.securePayload,
                sessionId: encryptedResult.sessionId,
                clientMessageId,
              };
              wasEncrypted = true;
            }
          } catch (encErr) {
            console.warn("[e2ee] Direct encryption error, sending via fallback:", encErr);
          }
        }

        const { data } = await axios.post(
          `api/messages/send/${selectedUser._id}`,
          sendPayload
        );
        if (data.success) {
          const displayedMessage = wasEncrypted
            ? {
                ...data.message,
                text: messagePayload.text,
                image: displayedImage,
                isEncrypted: true,
              }
            : data.message;

          setMessages((prevMessages) => {
            if (prevMessages.some((m) => m._id === data.message._id || (m.clientMessageId && m.clientMessageId === data.message.clientMessageId))) {
              return prevMessages;
            }
            return [...prevMessages, displayedMessage];
          });
        } else {
          toast.error(data.message);
        }
      }
    } catch (error) {
      toast.error(getErrorMsg(error));
    }
  };

  // function to subscribe to messages for selected user
  const subscribeToMessages = () => {
    if (!socket) return;

    socket.on("newMessage", async (newMessage) => {
      // Handle Group Message
      if (newMessage.groupId) {
        if (selectedGroup && newMessage.groupId === selectedGroup._id) {
          const senderId = typeof newMessage.senderId === 'object' ? newMessage.senderId._id : newMessage.senderId;
          if (senderId === authUser._id) return;

          let processed = newMessage;
          if (newMessage.secure?.encrypted) {
            const decrypted = await decryptGroupMessage(newMessage, authUser?._id, selectedGroup, axios);
            let resolvedImage = decrypted.image;
            if (!resolvedImage && decrypted.media) {
              resolvedImage = await fetchAndDecryptMedia(axios, decrypted.media);
            }
            processed = {
              ...newMessage,
              text: decrypted.text,
              image: resolvedImage,
              media: decrypted.media,
              isEncrypted: decrypted.isEncrypted,
              failed: decrypted.failed,
            };
          }

          setMessages((prev) => {
            if (prev.some((m) => m._id === processed._id || (m.clientMessageId && m.clientMessageId === processed.clientMessageId))) {
              return prev;
            }
            return [...prev, processed];
          });
        } else {
          setUnseenMessages((prev) => ({
            ...prev,
            [newMessage.groupId]: (prev[newMessage.groupId] || 0) + 1,
          }));
        }
      } 
      // Handle Direct Message
      else {
        const rawSenderId = typeof newMessage.senderId === 'object' ? newMessage.senderId._id : newMessage.senderId;
        const senderUser = (selectedUser && selectedUser._id === rawSenderId)
          ? selectedUser
          : users.find((u) => u._id === rawSenderId);

        let processedMessage = newMessage;
        if (newMessage.secure?.encrypted) {
          const decrypted = await decryptDirectMessage(newMessage, authUser?._id, senderUser);
          let resolvedImage = decrypted.image;
          if (!resolvedImage && decrypted.media) {
            resolvedImage = await fetchAndDecryptMedia(axios, decrypted.media);
          }
          processedMessage = {
            ...newMessage,
            text: decrypted.text,
            image: resolvedImage,
            media: decrypted.media,
            isEncrypted: decrypted.isEncrypted,
            failed: decrypted.failed,
          };
        }

        if (selectedUser && rawSenderId === selectedUser._id) {
          processedMessage.status = "read";
          setMessages((prevMessages) => {
            if (prevMessages.some((m) => m._id === processedMessage._id || (m.clientMessageId && m.clientMessageId === processedMessage.clientMessageId))) {
              return prevMessages;
            }
            return [...prevMessages, processedMessage];
          });
          axios.put(`/api/messages/mark/${selectedUser._id}`);
        } else {
          setUnseenMessages((prevUnseenMessages) => ({
            ...prevUnseenMessages,
            [rawSenderId]: prevUnseenMessages[rawSenderId]
              ? prevUnseenMessages[rawSenderId] + 1
              : 1,
          }));
        }
      }
    });

    // Listen for single message status updates (e.g. sent -> delivered)
    socket.on("messageStatusUpdate", (updatedMessage) => {
        setMessages((prev) => 
            prev.map((msg) => msg._id === updatedMessage._id ? updatedMessage : msg)
        );
    });

    // Listen for bulk read updates (e.g. user read all my messages)
    socket.on("messagesRead", ({ readerId }) => {
        setMessages((prev) => 
            prev.map((msg) => {
                if (msg.receiverId === readerId && msg.status !== "read") {
                    return { ...msg, status: "read" };
                }
                return msg;
            })
        );
    });

    // Listen for bulk delivered updates (e.g. recipient came online, sent messages become delivered)
    socket.on("messagesDelivered", ({ recipientId }) => {
        setMessages((prev) => 
            prev.map((msg) => {
                if (msg.receiverId === recipientId && msg.status === "sent") {
                    return { ...msg, status: "delivered" };
                }
                return msg;
            })
        );
    });

    // Listen for new group invitations in real time
    socket.on("groupInvite", ({ group, message }) => {
      setGroups((prev) => {
        if (prev.some((g) => g._id === group._id)) return prev;
        return [group, ...prev];
      });
      toast.success(message || `You were invited to group "${group.name}"!`);
    });

    // Listen for group membership/profile updates in real time
    socket.on("groupUpdated", (updatedGroup) => {
      setGroups((prev) =>
        prev.map((g) => (g._id === updatedGroup._id ? updatedGroup : g))
      );
    });
  };

  // function to unsubscribe from messages for selected user
  const unsubscribeFromMessages = () => {
    if (!socket) return;
    socket.off("newMessage");
    socket.off("messageStatusUpdate");
    socket.off("messagesRead");
    socket.off("messagesDelivered");
    socket.off("groupInvite");
    socket.off("groupUpdated");
  };

  useEffect(() => {
    subscribeToMessages();
    return () => {
      unsubscribeFromMessages();
    };
  }, [socket, selectedUser, selectedGroup]); // added selectedGroup dep

  const value = {
    messages,
    users,
    groups, // [NEW]
    selectedUser,
    selectedGroup, // [NEW]
    unseenMessages,
    setMessages,
    getMessages,
    getGroupMessages, // [NEW]
    sendMessage,
    setSelectedUser,
    setSelectedGroup, // [NEW]
    setUnseenMessages,
    getUsers,
    fetchGroups, // [NEW]
    createGroup, // [NEW]
    inviteToGroup, // [NEW]
    acceptInvite, // [NEW]
    rejectInvite, // [NEW]
  };
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

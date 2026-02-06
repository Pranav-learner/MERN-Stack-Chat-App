import { createContext, useState, useContext, useEffect } from "react";
import { AuthContext } from "../context/AuthContext";
import toast from "react-hot-toast";

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

  // function to create group
  const createGroup = async (name, invitedUserIds) => {
    try {
      const { data } = await axios.post("/api/groups/create", { name, invitedUserIds });
      if (data.success) {
        setGroups((prev) => [...prev, data.group]);
        toast.success("Group created successfully");
        return true;
      }
    } catch (error) {
      toast.error(error.message);
      return false;
    }
  };

  const inviteToGroup = async (groupId, userId) => {
      try {
          const { data } = await axios.post("/api/groups/invite", { groupId, userId });
           if(data.success) toast.success(data.message);
      } catch (error) {
          toast.error(error.message);
      }
  }

  const acceptInvite = async (groupId) => {
      try {
          const { data } = await axios.post("/api/groups/accept", { groupId });
           if(data.success) {
               toast.success(data.message);
               fetchGroups(); // refresh to update member status
           }
      } catch (error) {
          toast.error(error.message);
      }
  }

    const rejectInvite = async (groupId) => {
      try {
          const { data } = await axios.post("/api/groups/reject", { groupId });
           if(data.success) {
               toast.success(data.message);
               fetchGroups(); 
           }
      } catch (error) {
          toast.error(error.message);
      }
  }

  // function to messages of selected user OR group
  const getMessages = async (userId) => {
    try {
      // If we are in group mode, userId is actually groupId. Logic: if selectedGroup is set.
      // Actually, cleaner to separate or pass a flag. 
      // Existing usage passes userId.
      const { data } = await axios.get(`api/messages/${userId}`);
      if (data.success) {
        setMessages(data.messages);
      }
    } catch (error) {
      toast.error(error.message);
    }
  };

  const getGroupMessages = async (groupId) => {
      setUnseenMessages((prev) => ({ ...prev, [groupId]: 0 }));
      try {
          const { data } = await axios.get(`/api/groups/${groupId}/messages`);
          if (data.success) {
              setMessages(data.messages);
          }
      } catch (error) {
          toast.error(error.message);
      }
  }

  // function to send message to selected user or group
  const sendMessage = async (messages) => {
    try {
      if (selectedGroup) {
          const { data } = await axios.post(`/api/groups/send/${selectedGroup._id}`, messages);
           if (data.success) {
               setMessages((prevMessages) => [...prevMessages, data.message]);
           } else {
               toast.error(data.message);
           }
      } else if (selectedUser) {
          const { data } = await axios.post(
            `api/messages/send/${selectedUser._id}`,
            messages
          );
          if (data.success) {
            setMessages((prevMessages) => [...prevMessages, data.message]);
          } else {
            toast.error(data.message);
          }
      }
    } catch (error) {
      toast.error(error.message);
    }
  };

  //funtion to subscribe to messages for selected user
  const subscribeToMessages = () => {
    if (!socket) return;

    socket.on("newMessage", (newMessage) => {
      // Handle Group Message
      if (newMessage.groupId) {
          if (selectedGroup && newMessage.groupId === selectedGroup._id) {
               const senderId = typeof newMessage.senderId === 'object' ? newMessage.senderId._id : newMessage.senderId;
               if (senderId === authUser._id) return;

               setMessages((prev) => [...prev, newMessage]);
               // Groups don't have "seen" logic per member easily yet
          } else {
              setUnseenMessages((prev) => ({
                ...prev,
                [newMessage.groupId]: (prev[newMessage.groupId] || 0) + 1,
              }));
          }
      } 
      // Handle Direct Message
      else {
          if (selectedUser && newMessage.senderId === selectedUser._id) {
            // newMessage.seen = true; // DB handles this via API call, but UI needs update
            newMessage.status = "read";
            setMessages((prevMessages) => [...prevMessages, newMessage]);
            axios.put(`/api/messages/mark/${selectedUser._id}`);
          } else {
            setUnseenMessages((prevUnseenMessages) => ({
              ...prevUnseenMessages,
              [newMessage.senderId]: prevUnseenMessages[newMessage.senderId]
                ? prevUnseenMessages[newMessage.senderId] + 1
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
  };

  // function to unsubscribe from messages for selected user
  const unsubscribeFromMessages = () => {
    if (!socket) return;
    socket.off("newMessage");
    socket.off("messageStatusUpdate");
    socket.off("messagesRead");
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

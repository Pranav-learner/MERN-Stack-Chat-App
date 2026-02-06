import React, { useState, useEffect } from "react";
import assets from "../assets/assets";
import { useNavigate } from "react-router-dom";
import { useContext } from "react";
import { AuthContext } from "../../context/AuthContext";
import { ChatContext } from "../../context/ChatContext";

import CreateGroupModal from "./CreateGroupModal";

const Sidebar = () => {
  const {
    getUsers,
    users,
    selectedUser,
    setSelectedUser,
    messages,
    getMessages,
    unseenMessages,
    setUnseenMessages,
    groups, 
    fetchGroups, 
    selectedGroup, 
    setSelectedGroup, 
    getGroupMessages, 
    acceptInvite, 
    inviteToGroup, 
  } = useContext(ChatContext);

  const { logout, onlineUser, authUser } = useContext(AuthContext); // authUser for checking invites

  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState("chats"); // "chats" or "groups"
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  const navigate = useNavigate();

  const filteredUsers = Array.isArray(users)
    ? input
      ? users.filter((user) =>
          user.fullName.toLowerCase().includes(input.toLowerCase())
        )
      : users
    : [];

  const filteredGroups = Array.isArray(groups)
     ? input
       ? groups.filter((group) => group.name.toLowerCase().includes(input.toLowerCase()))
       : groups
     : [];

  useEffect(() => {
    getUsers();
    fetchGroups();
  }, [onlineUser]);

  useEffect(() => {
    if (selectedUser) {
      getMessages(selectedUser._id);
    }
  }, [selectedUser]);

  // Handle invite acceptance (simple implementation: if in pendingMembers)
  const isPending = (group) => group.pendingMembers.some(member => member._id === authUser._id);

  return (
    <div
      className={`bg-[#8185B2]/10 h-full p-5 rounded-r-xl overflow-y-scroll text-white ${
        (selectedUser || selectedGroup) ? "max-md:hidden" : ""
      }`}
    >
      <div className="pb-5">
        <div className="flex justify-between items-center">
          <img src={assets.logo} alt="logo" className="max-w-40" />
          <div className="relative py-2 group">
             {/* ... Menu ... */}
             <img
              src={assets.menu_icon}
              alt="logo"
              className="max-h-5 cursor-pointer"
            />
            <div className="absolute top-full right-0 z-20 w-32 p-5 rounded-md bg-[#282142] border border-gray-600 text-gray-100 hidden group-hover:block">
              <p
                onClick={() => navigate("/profile")}
                className="cursor-pointer text-sm"
              >
                Edit Profile
              </p>
              <hr className="my-2 border-t border-gray-500" />
              <p onClick={() => logout()} className="cursor-pointer text-sm">
                Logout
              </p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mt-4 border-b border-gray-600 pb-2">
            <button 
                className={`text-sm font-semibold pb-1 ${activeTab === "chats" ? "text-violet-400 border-b-2 border-violet-400" : "text-gray-400"}`}
                onClick={() => setActiveTab("chats")}
            >
                Direct Messages
            </button>
            <button 
                className={`text-sm font-semibold pb-1 ${activeTab === "groups" ? "text-violet-400 border-b-2 border-violet-400" : "text-gray-400"}`}
                onClick={() => setActiveTab("groups")}
            >
                Groups
            </button>
        </div>

        <div className="bg-[#282142] rounded-full flex items-center gap-2 py-3 px-4 mt-5">
          <img src={assets.search_icon} alt="search" className="w-3" />
          <input
            onChange={(e) => setInput(e.target.value)}
            type="text"
            className="bg-transparent border-none outline-none text-white text-xs placeholder-[#c8c8c8] flex-1"
            placeholder={`Search ${activeTab === "chats" ? "User" : "Group"}...`}
          />
        </div>

        {activeTab === "groups" && (
            <button
                onClick={() => setShowCreateGroup(true)}
                className="w-full mt-4 bg-violet-600/20 hover:bg-violet-600/40 text-violet-300 text-sm py-2 rounded transition"
            >
                + Create New Group
            </button>
        )}
      </div>

      <div className="flex flex-col">
        {activeTab === "chats" ? (
            filteredUsers.map((user, index) => (
            <div
                onClick={() => {
                setSelectedUser(user);
                setSelectedGroup(null);
                setUnseenMessages((prev) => ({ ...prev, [user._id]: 0 }));
                getMessages(user._id);
                }}
                key={index}
                className={`relative flex items-center gap-2 p-2 pl-4 rounded cursor-pointer max-sm:text-sm ${
                selectedUser?._id === user._id && "bg-[#282142]/50"
                }`}
            >
                <img
                src={user?.profilePic || assets.avatar_icon}
                alt=""
                className="w-[35px] aspect-[1/1] rounded-full object-cover"
                />
                <div className="flex flex-col leading-5">
                <p>{user?.fullName}</p>
                {(onlineUser || []).includes(user._id) ? (
                    <span className="text-green-400 text-xs">Online</span>
                ) : (
                    <span className="text-neutral-400 text-xs">Offline</span>
                )}
                </div>
                {unseenMessages[user._id] > 0 && (
                <p className="absolute top-4 right-4 text-xs h-5 w-5 flex justify-center items-center rounded-full bg-violet-500/50">
                    {unseenMessages[user._id]}
                </p>
                )}
            </div>
            ))
        ) : (
            filteredGroups.map((group, index) => (
                <div
                    key={index}
                    onClick={() => {
                        if (!isPending(group)) {
                            setSelectedGroup(group);
                            setSelectedUser(null);
                            getGroupMessages(group._id);
                        }
                    }}
                    className={`relative flex items-center gap-2 p-2 pl-4 rounded cursor-pointer max-sm:text-sm ${
                        selectedGroup?._id === group._id ? "bg-[#282142]/50" : ""
                    } ${isPending(group) ? "opacity-70" : ""}`}
                >
                    <div className="w-[35px] h-[35px] rounded-full bg-violet-500/20 flex items-center justify-center text-violet-300 font-bold border border-violet-500/30">
                        {group.name[0]?.toUpperCase()}
                    </div>
                    <div className="flex flex-col leading-5 flex-1">
                        <p>{group.name}</p>
                        <span className="text-xs text-gray-400">{group.members.length} members</span>
                    </div>
                    
                    {unseenMessages[group._id] > 0 && (
                        <div className="absolute top-4 right-16 text-xs h-5 w-5 flex justify-center items-center rounded-full bg-violet-500/50">
                            {unseenMessages[group._id]}
                        </div>
                    )}

                    {isPending(group) && (
                        <button 
                            onClick={(e) => {
                                e.stopPropagation();
                                acceptInvite(group._id);
                            }}
                            className="text-xs bg-green-600/20 text-green-400 px-2 py-1 rounded hover:bg-green-600/40"
                        >
                            Accept
                        </button>
                    )}
                </div>
            ))
        )}
      </div>

      {showCreateGroup && <CreateGroupModal onClose={() => setShowCreateGroup(false)} />}
    </div>
  );
};

export default Sidebar;

import React, { useState, useContext } from "react";
import { ChatContext } from "../../context/ChatContext";
import assets from "../assets/assets";

const CreateGroupModal = ({ onClose }) => {
  const { users, createGroup } = useContext(ChatContext);
  const [groupName, setGroupName] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [query, setQuery] = useState("");

  const handleUserSelect = (userId) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    const success = await createGroup(groupName, selectedUserIds);
    if (success) onClose();
  };

  const filteredUsers = users.filter((user) =>
    user.fullName.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[#1a1a2e] border border-gray-600 p-6 rounded-lg w-full max-w-md shadow-xl">
        <h2 className="text-xl font-bold text-white mb-4">Create New Group</h2>
        
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Group Name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            className="p-2 rounded bg-[#282142] text-white border border-gray-600 focus:outline-none focus:border-violet-500"
            required
          />

          <div className="flex flex-col gap-2">
            <label className="text-sm text-gray-400">Invite Members</label>
            <input
              type="text"
              placeholder="Search users..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="p-2 rounded bg-[#282142] text-white border border-gray-600 text-sm mb-2"
            />
            
            <div className="max-h-40 overflow-y-auto border border-gray-700 rounded p-2">
              {filteredUsers.map((user) => (
                <div
                  key={user._id}
                  onClick={() => handleUserSelect(user._id)}
                  className={`flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-white/5 ${
                    selectedUserIds.includes(user._id) ? "bg-violet-600/30" : ""
                  }`}
                >
                  <img
                    src={user.profilePic || assets.avatar_icon}
                    alt=""
                    className="w-8 h-8 rounded-full"
                  />
                  <p className="text-sm text-white">{user.fullName}</p>
                  {selectedUserIds.includes(user._id) && (
                    <span className="ml-auto text-green-400 text-xs">Selected</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded text-gray-300 hover:bg-white/10 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded bg-violet-600 text-white hover:bg-violet-700 transition"
            >
              Create Group
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateGroupModal;

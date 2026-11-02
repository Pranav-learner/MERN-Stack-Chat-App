import React, { useState, useEffect, useRef } from "react";
import assets from "../assets/assets";
import { formatMessageTime } from "../lib/utils";
import { useContext } from "react";
import { ChatContext } from "../../context/ChatContext";
import { AuthContext } from "../../context/AuthContext";
import toast from "react-hot-toast";

const ChatContainer = () => {
  const { messages, selectedUser, setSelectedUser, sendMessage, getMessages, selectedGroup, setSelectedGroup, getGroupMessages, syncStatus } =
    useContext(ChatContext);
  const { authUser, onlineUser } = useContext(AuthContext);

  const scrollEnd = useRef();

  const [input, setInput] = useState("");

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (input.trim() === "") return;
    await sendMessage({ text: input.trim() });
    setInput("");
  };

  const handleSendImage = async (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith("image/")) {
      toast.error("Please select an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image file exceeds the 5MB size limit.");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = async () => {
      await sendMessage({ image: reader.result, file });
      e.target.value = "";
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (selectedUser) {
      getMessages(selectedUser._id);
    } else if (selectedGroup) {
      getGroupMessages(selectedGroup._id);
    }
  }, [selectedUser, selectedGroup]);

  useEffect(() => {
    if (scrollEnd.current && messages) {
      scrollEnd.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const currentChat = selectedUser || selectedGroup;
  
  if (!currentChat) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 text-gray-500 bg-white/10 max-md:hidden h-full">
        <img src={assets.logo_icon} alt="" className="max-w-16" />
        <p className="text-lg font-medium text-white">Chat anytime, anywhere</p>
        </div>
    );
  }

  return (
    <div className="h-full overflow-scroll relative backdrop-blur-lg">
      {/* chat header */}
      <div className="flex items-center gap-3 py-3 mx-4 border-b border-stone-500">
        {selectedUser ? (
            <img
            src={selectedUser.profilePic || assets.avatar_icon}
            alt=""
            className="w-8 rounded-full"
            />
        ) : (
             <div className="w-8 h-8 rounded-full bg-violet-500 flex items-center justify-center text-white font-bold">
                 {selectedGroup.name[0]?.toUpperCase()}
             </div>
        )}
        
        <p className="flex-1 text-lg text-white flex items-center gap-2">
          {selectedUser ? selectedUser.fullName : selectedGroup.name}
          {selectedUser && onlineUser.includes(selectedUser._id) && (
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
          )}
          {selectedUser && (
            selectedUser.publicKey ? (
              <span className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-normal ml-2">
                <span>🔒</span> End-to-End Encrypted
              </span>
            ) : (
              <span className="text-[11px] bg-amber-500/10 text-amber-300 border border-amber-500/20 px-2 py-0.5 rounded-full font-normal ml-2">
                Plaintext (No Key)
              </span>
            )
          )}
          {selectedGroup && (
            <>
              <span className="text-xs text-gray-400 ml-2">({selectedGroup.members.length} members)</span>
              <span className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-normal ml-2">
                <span>🔒</span> Group Encrypted
              </span>
            </>
          )}

          {syncStatus && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full ml-auto flex items-center gap-1 ${
                syncStatus.status === "offline"
                  ? "bg-red-500/20 text-red-300 border border-red-500/30"
                  : syncStatus.status === "syncing"
                  ? "bg-blue-500/20 text-blue-300 border border-blue-500/30 animate-pulse"
                  : "text-gray-400 bg-white/5 border border-white/10"
              }`}
              title="Layer 9 — Offline Sync & State Replication"
            >
              {syncStatus.status === "offline"
                ? `⚠️ Offline (${syncStatus.pendingCount} queued)`
                : syncStatus.status === "syncing"
                ? "🔄 Syncing..."
                : "⚡ Synced"}
            </span>
          )}
        </p>
        <img
          onClick={() => { setSelectedUser(null); setSelectedGroup(null); }}
          src={assets.arrow_icon}
          alt=""
          className="md:hidden max-w-7 cursor-pointer"
        />
        <img src={assets.help_icon} alt="" className="max-md:hidden max-w-5" />
      </div>
      {/* Chat Area  */}
      <div className="flex flex-col h-[calc(100%-120px)] overflow-y-scroll p-3 pb-6">
        {messages.map((msg, index) => {
            const senderId = typeof msg.senderId === 'object' ? msg.senderId._id : msg.senderId;
            const isMe = senderId === authUser._id;
            const senderProfile = typeof msg.senderId === 'object' ? msg.senderId.profilePic : selectedUser?.profilePic;
            const senderName = typeof msg.senderId === 'object' ? msg.senderId.fullName : selectedUser?.fullName;

            return (
                <div
                    key={index}
                    className={`flex items-end gap-2 justify-end ${
                    !isMe && "flex-row-reverse"
                    }`}
                >
                    <div className="flex flex-col items-end">
                       {/* Show sender name for group chats if not me */}
                       {selectedGroup && !isMe && (
                           <span className="text-[10px] text-gray-400 mr-1 mb-1 self-end">{senderName}</span>
                       )}
                        
                        {msg.failed ? (
                          <div className="p-2.5 max-w-[280px] text-xs rounded-lg mb-8 bg-red-950/80 text-red-200 border border-red-500/40 flex items-start gap-2 shadow-lg backdrop-blur-sm">
                            <span className="text-sm">⚠️</span>
                            <div>
                              <p className="font-semibold text-red-100">Decryption Failed</p>
                              <p className="text-[11px] text-red-300">Message was tampered with or corrupted in transit.</p>
                            </div>
                          </div>
                        ) : msg.image ? (
                          <div className="relative group mb-8">
                            <img
                                src={msg.image}
                                alt=""
                                className="max-w-[230px] border border-gray-700 rounded-lg overflow-hidden shadow-md"
                            />
                            {(msg.isEncrypted || msg.media) && (
                              <span className="absolute top-2 right-2 bg-black/70 backdrop-blur-md px-1.5 py-0.5 rounded text-[10px] text-emerald-300 font-medium border border-emerald-500/30 flex items-center gap-1">
                                🔒 Encrypted Media
                              </span>
                            )}
                          </div>
                        ) : msg.media && !msg.image ? (
                          <div className="p-3 max-w-[220px] text-xs rounded-lg mb-8 bg-gray-800/80 text-gray-300 border border-gray-700 flex items-center gap-2">
                            <span className="animate-spin text-sm">⏳</span>
                            <span>Decrypting secure media...</span>
                          </div>
                        ) : (
                        <p
                            className={`p-2 max-w-[200px] md:text-sm font-light rounded-lg mb-8 break-all bg-violet-500/30 text-white ${
                            isMe
                                ? "rounded-br-none"
                                : "rounded-bl-none"
                            }`}
                        >
                            {msg.text}
                        </p>
                        )}
                    </div>

                    <div className="text-center text-xs">
                    <img
                        src={
                        isMe
                            ? authUser?.profilePic || assets.avatar_icon
                            : senderProfile || assets.avatar_icon
                        }
                        alt=""
                        className="w-7 rounded-full object-cover"
                    />
                    <p className="text-gray-500 flex items-center justify-center gap-1">
                        {formatMessageTime(msg.createdAt)}
                        {(msg.isEncrypted || msg.secure?.encrypted) && (
                            <span title="End-to-End Encrypted" className="text-emerald-400 text-[10px]">🔒</span>
                        )}
                        {isMe && (
                            <span className={`${msg.status === 'read' ? 'text-blue-400' : 'text-gray-500'}`}>
                                {msg.status === 'queued' ? (
                                  <span title="Queued offline for sync" className="text-amber-400 font-bold">🕒</span>
                                ) : msg.status === 'sent' ? (
                                  '✓'
                                ) : (
                                  '✓✓'
                                )}
                            </span>
                        )}
                    </p>
                    </div>
                </div>
            )
        })}
        <div ref={scrollEnd}></div>
      </div>
      {/* Bottom Area for typing */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-3 p-3">
        <div className="flex-1 flex items-center bg-gray-100/12 px-3 rounded-full">
          <input
            onChange={(e) => setInput(e.target.value)}
            value={input}
            onKeyDown={(e) => (e.key === "Enter" ? handleSendMessage(e) : null)}
            type="text"
            placeholder={selectedUser ? (selectedUser.publicKey ? "🔒 Send encrypted message..." : "Send a message") : "🔒 Send encrypted group message..."}
            className="flex-1 text-sm p-3 border-none rounded-lg outline-none text-white placeholder-gray-400"
          />
          <input
            onChange={handleSendImage}
            type="file"
            id="image"
            accept="image/png, image/jpeg"
            hidden
          />
          <label htmlFor="image">
            <img
              src={assets.gallery_icon}
              alt=""
              className="w-5 mr-2 cursor-pointer"
            />
          </label>
        </div>
        <img
          onClick={handleSendMessage}
          src={assets.send_button}
          alt=""
          className="w-7 cursor-pointer"
        />
      </div>
    </div>
  );
};

export default ChatContainer;

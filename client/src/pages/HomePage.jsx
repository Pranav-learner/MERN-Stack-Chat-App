import React from "react";
import { useState } from "react";
import { useContext } from "react";
import Sidebar from "../components/Sidebar";
import ChatContainer from "../components/ChatContainer";
import RightSidebar from "../components/RightSidebar";
import { ChatContext } from "../../context/ChatContext";

function HomePage() {
  const { selectedUser } = useContext(ChatContext);

  return (
    <div className="border w-full h-screen sm:px-[15%] sm:py-[5%] flex flex-col justify-center">
      <div className="mb-2 px-3 py-1 bg-amber-500/20 border border-amber-500/40 rounded-lg text-amber-200 text-[11px] text-center flex items-center justify-center gap-2">
        <span className="bg-amber-500/40 text-amber-300 font-semibold uppercase px-1.5 py-0.5 rounded text-[9px] tracking-wider">Demo Notice</span>
        <span>Standard client-server transport (HTTPS/WSS). Do not submit confidential data.</span>
      </div>
      <div
        className={`backdrop-blur-xl border-2 border-gray-600 rounded-2xl 
      overflow-hidden flex-1 grid grid-cols-1 relative ${
        selectedUser
          ? "md:grid-cols-[1fr_1.5fr_1fr] xl:grid-cols-[1fr_2fr_1fr]"
          : "md:grid-cols-2"
      }`}
      >
        <Sidebar />
        <ChatContainer />
        <RightSidebar />
      </div>
    </div>
  );
}

export default HomePage;

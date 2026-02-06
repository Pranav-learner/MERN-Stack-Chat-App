import express from "express";
import dotenv from "dotenv/config";
import cors from "cors";
import http from "http";
import { connectDB } from "./lib/db.js";
import userRouter from "./routes/userRoute.js";
import messageRouter from "./routes/messageRoute.js";
import groupRouter from "./routes/groupRoute.js";
import Group from "./models/Group.model.js";
import { Server } from "socket.io";

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

import { cacheUserSocket, removeUserSocket, getOnlineUsers } from "./lib/redis.js";

// Intialise Socket.io
export const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Socket.io connection handler
io.on("connection", async (socket) => {
  const userId = socket.handshake.query.userId;

  if (userId) {
    await cacheUserSocket(userId, socket.id);

    // Emit online users to all connected clients
    const onlineUsers = await getOnlineUsers();
    io.emit("onlineUsers", onlineUsers);

    // Join user to their group rooms
    try {
      const groups = await Group.find({ members: userId });
      groups.forEach((group) => {
        socket.join(group._id.toString());
      });
    } catch (error) {
      console.error("Error joining group rooms:", error);
    }
  }

  socket.on("disconnect", async () => {
    if (userId) {
      await removeUserSocket(userId);
      const onlineUsers = await getOnlineUsers();
      io.emit("onlineUsers", onlineUsers);
    }
  });
});
// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// API Routes
app.use("/api/status", (req, res) => {
  res.send("Server is live");
});
app.use("/api/auth", userRouter);
app.use("/api/messages", messageRouter);
app.use("/api/groups", groupRouter);

// Connect to MongoDB
await connectDB();

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// Export server for Vercel
export default server;

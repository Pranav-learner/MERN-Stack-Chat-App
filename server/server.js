import express from "express";
import dotenv from "dotenv/config";
import cors from "cors";
import http from "http";
import { connectDB } from "./lib/db.js";
import userRouter from "./routes/userRoute.js";
import messageRouter from "./routes/messageRoute.js";
import groupRouter from "./routes/groupRoute.js";
import identityRouter from "./routes/identityRoute.js";
import deviceRouter from "./routes/deviceRoute.js";
import trustRouter from "./routes/trustRoute.js";
import sessionRouter from "./routes/sessionRoute.js";
import handshakeRouter from "./routes/handshakeRoute.js";
import keyAgreementRouter from "./routes/keyAgreementRoute.js";
import secureSessionRouter from "./routes/secureSessionRoute.js";
import { identityContextService, verifyToken, attachSocketIdentity } from "./integration/index.js";
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

  // Layer 3 Sprint 4 — attach identity context to the socket (additive, backward
  // compatible). Does not change presence/rooms/delivery; adds identity awareness.
  try {
    const identity = await attachSocketIdentity(socket, {
      service: identityContextService,
      verifyToken,
    });
    if (identity) socket.emit("identityContext", identity);
  } catch (error) {
    console.error("Error attaching socket identity:", error?.message);
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
// Layer 3 — Secure Identity (additive; does not alter existing routes/auth/JWT)
app.use("/api/identity", identityRouter);
// Layer 3 Sprint 2 — Device Trust & Multi-Device Management (additive)
app.use("/api/devices", deviceRouter);
// Layer 3 Sprint 3 — Identity Verification & Trust Establishment (additive)
app.use("/api/trust", trustRouter);
// Layer 3 Sprint 4 — Identity integration: consolidated session/identity context
app.use("/api/session", sessionRouter);
// Layer 4 Sprint 1 — Secure Handshake System: protocol lifecycle (no shared secrets yet)
app.use("/api/handshake", handshakeRouter);
// Layer 4 Sprint 2 — Secure Key Agreement: relays public ephemeral keys; server never sees the shared secret
app.use("/api/key-agreement", keyAgreementRouter);
// Layer 4 Sprint 3 — Secure Sessions: tracks session lifecycle metadata; server never holds session keys
app.use("/api/secure-session", secureSessionRouter);

// Connect to MongoDB
console.log("Attempting to connect to MongoDB...");
await connectDB();
console.log("MongoDB connection attempt finished.");

const PORT = process.env.PORT || 5000;
console.log(`Checking PORT: ${PORT}`);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Promise Rejection:", err);
});

// Export server for Vercel
export default server;

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
import sessionMessagingRouter from "./routes/sessionMessagingRoute.js";
import secureTransportRouter from "./routes/secureTransportRoute.js";
import sessionEvolutionRouter from "./routes/sessionEvolutionRoute.js";
import forwardSecrecyRouter from "./routes/forwardSecrecyRoute.js";
import automaticRekeyRouter from "./routes/automaticRekeyRoute.js";
import keyHierarchyRouter from "./routes/keyHierarchyRoute.js";
import messageKeyRouter from "./routes/messageKeyRoute.js";
import cryptoHardeningRouter from "./routes/cryptoHardeningRoute.js";
import discoveryRouter from "./routes/discoveryRoute.js";
import presenceRouter from "./routes/presenceRoute.js";
import capabilityRouter from "./routes/capabilityRoute.js";
import pdpRouter from "./routes/pdpRoute.js";
import endpointSelectionRouter from "./routes/endpointSelectionRoute.js";
import networkingHardeningRouter from "./routes/networkingHardeningRoute.js";
import { presenceService, presenceEvents, heartbeatMonitor } from "./controllers/presenceController.js";
import { PresenceEventType } from "./presence/events/events.js";
import { identityContextService, verifyToken, attachSocketIdentity } from "./integration/index.js";
// Layer 4 · Sprint 5 — session-aware socket transport.
import { appSessions } from "./controllers/sessionMessagingController.js";
import { attachSocketSessionContext } from "./session-integration/index.js";
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

    // Layer 4 Sprint 5 — attach session-aware transport context to the socket
    // (identity + device + session status + handshake readiness). Additive; does not
    // change presence/rooms/delivery. No transport encryption.
    const sessionSummary = attachSocketSessionContext(socket, { appSessions });
    socket.emit("sessionTransport", sessionSummary);
  } catch (error) {
    console.error("Error attaching socket identity:", error?.message);
  }

  // Layer 6 Sprint 2 — real-time presence. If the client supplies a stable deviceId in the
  // handshake, register/refresh its presence for the life of the socket. Additive + defensive:
  // any failure here never affects existing presence/rooms/delivery. Answers "reachable?" only —
  // NO transport negotiation.
  const deviceId = socket.handshake.query.deviceId;
  if (userId && deviceId) {
    try {
      const record = await presenceService.onConnect({
        userId,
        deviceId,
        platform: socket.handshake.query.platform,
        softwareVersion: socket.handshake.query.appVersion,
      });
      socket.emit("presenceSelf", record);
    } catch (error) {
      console.error("Error registering presence:", error?.message);
    }

    // Client-driven heartbeat over the socket (cheaper than the REST heartbeat).
    socket.on("presence:heartbeat", async () => {
      try {
        await presenceService.onHeartbeat({ userId, deviceId });
      } catch (error) {
        console.error("Error on presence heartbeat:", error?.message);
      }
    });

    // Client-driven status change (online / away / busy / invisible).
    socket.on("presence:status", async (payload) => {
      try {
        const record = await presenceService.manager.setDeviceStatus(userId, deviceId, payload?.status, { actingUser: userId });
        socket.emit("presenceSelf", record);
      } catch (error) {
        console.error("Error on presence status update:", error?.message);
      }
    });
  }

  socket.on("disconnect", async () => {
    if (userId) {
      await removeUserSocket(userId);
      const onlineUsers = await getOnlineUsers();
      io.emit("onlineUsers", onlineUsers);

      // Layer 6 Sprint 2 — mark the device disconnected (a later heartbeat recovers it, or the
      // sweep expires it). Defensive; never blocks the existing disconnect flow.
      if (deviceId) {
        try {
          await presenceService.onDisconnect({ userId, deviceId, reason: "socket-closed" });
        } catch (error) {
          console.error("Error marking presence disconnected:", error?.message);
        }
      }
    }
  });
});

// Layer 6 Sprint 2 — broadcast presence transitions so connected clients can update their UI in
// real time. Additive: a separate channel from the existing `onlineUsers` event.
for (const type of [PresenceEventType.ONLINE, PresenceEventType.OFFLINE, PresenceEventType.EXPIRED, PresenceEventType.RECOVERED, PresenceEventType.UPDATED]) {
  presenceEvents.on(type, (event) => {
    try {
      io.emit("presenceChanged", { type: event.type, userId: event.userId, deviceId: event.deviceId, status: event.status });
    } catch {
      // best-effort broadcast
    }
  });
}
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
// Layer 4 Sprint 5 — Secure Session Integration: session-aware messaging status/stats
app.use("/api/messaging-session", sessionMessagingRouter);
// Layer 4 Sprint 6 — Secure Transport: E2E relay status/metrics (server never decrypts)
app.use("/api/secure-transport", secureTransportRouter);
// Layer 5 Sprint 1 — Session Evolution: read-only generation/evolution awareness (no key rotation)
app.use("/api/session-evolution", sessionEvolutionRouter);
// Layer 5 Sprint 2 — Forward Secrecy: generation/key-evolution metadata + audit (server never holds keys)
app.use("/api/forward-secrecy", forwardSecrecyRouter);
// Layer 5 Sprint 3 — Automatic Rekeying: policy config + rekey history (evolution runs device-side)
app.use("/api/auto-rekey", automaticRekeyRouter);
// Layer 5 Sprint 4 — Key Hierarchy: root-key + sending/receiving chain metadata (keys device-side)
app.use("/api/key-hierarchy", keyHierarchyRouter);
// Layer 5 Sprint 5 — Per-Message Keys: message metadata (ephemeral keys derived + destroyed device-side)
app.use("/api/message-keys", messageKeyRouter);
// Layer 5 Sprint 6 — Cryptographic Hardening: metrics, security alerts, protocol freeze, replay status
app.use("/api/crypto-hardening", cryptoHardeningRouter);
// Layer 6 Sprint 1 — Peer Discovery: transport-independent control plane (who a peer is + which
// devices they have). No presence/capability/NAT/transport; returns PUBLIC metadata only.
app.use("/api/discovery", discoveryRouter);
// Layer 6 Sprint 2 — Presence: real-time device availability (which devices are reachable). No
// capability/NAT/transport; returns PUBLIC presence + advertisement metadata only.
app.use("/api/presence", presenceRouter);
// Layer 6 Sprint 3 — Capability Exchange: how two devices can communicate (compatibility +
// preferred transport). Determines a strategy only; NO NAT/ICE/WebRTC/connection establishment.
app.use("/api/capabilities", capabilityRouter);
// Layer 6 Sprint 4 — Peer Discovery Protocol: unifies discovery+presence+capabilities into one
// workflow producing validated Connection Plans (WHO + HOW). NO connection establishment (Layer 7).
app.use("/api/pdp", pdpRouter);
// Layer 6 Sprint 5 — Endpoint Selection: intelligent multi-device scoring/ranking → optimized,
// failover-ready Connection Plans. Selects endpoints only; NO NAT/ICE/WebRTC/connection (Layer 7).
app.use("/api/endpoint-selection", endpointSelectionRouter);
// Layer 6 Sprint 6 — Production Networking Hardening: read-only observability (health, metrics,
// Prometheus, alerts), frozen protocol manifest + API security audit for the whole control plane.
app.use("/api/networking-hardening", networkingHardeningRouter);

// Connect to MongoDB
console.log("Attempting to connect to MongoDB...");
await connectDB();
console.log("MongoDB connection attempt finished.");

// Layer 6 Sprint 2 — start the presence heartbeat monitor (periodic expiry sweeps). The timer is
// unref'd so it never keeps the process alive on its own.
heartbeatMonitor.start();
console.log("Presence heartbeat monitor started.");

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

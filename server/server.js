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
import networkDiscoveryRouter from "./routes/networkDiscoveryRoute.js";
import networkReliabilityRouter from "./routes/networkReliabilityRoute.js";
import dataPlaneRouter from "./routes/dataPlaneRoute.js";
import transportEngineRouter from "./routes/transportEngineRoute.js";
import transportReliabilityRouter from "./routes/transportReliabilityRoute.js";
import { stallMonitor } from "./controllers/transportReliabilityController.js";
import synchronizationRouter from "./routes/synchronizationRoute.js";
import replicationRouter from "./routes/replicationRoute.js";
import syncReliabilityRouter from "./routes/syncReliabilityRoute.js";
import { stallMonitor as syncStallMonitor } from "./controllers/syncReliabilityController.js";
import groupManagementRouter from "./routes/groupManagementRoute.js";
import groupCommunicationRouter from "./routes/groupCommunicationRoute.js";
import groupReliabilityRouter from "./routes/groupReliabilityRoute.js";
import { stallMonitor as groupStallMonitor } from "./controllers/groupReliabilityController.js";
import groupReceiptRouter from "./routes/groupReceiptRoute.js";
import mediaRouter from "./routes/mediaRoute.js";
import mediaDeliveryRouter from "./routes/mediaDeliveryRoute.js";
import mediaReliabilityRouter from "./routes/mediaReliabilityRoute.js";
import { stallMonitor as mediaStallMonitor } from "./controllers/mediaReliabilityController.js";
import communicationFabricRouter from "./routes/communicationFabricRoute.js";
import adaptiveRoutingRouter from "./routes/adaptiveRoutingRoute.js";
import { reliabilityHeartbeatMonitor } from "./controllers/networkReliabilityController.js";
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
// Layer 7 Sprint 1 — Network Discovery: discovers each device's network environment (interfaces,
// NAT via STUN) → Network Profiles + ICE-style candidates. NO ICE checks/TURN/WebRTC/connection.
app.use("/api/network-discovery", networkDiscoveryRouter);
// Layer 7 Sprint 3 — Network Reliability: makes active connections reliable (recovery, health,
// retry policies, observability). Carries NO application data (P2P messaging/media = Layer 8).
app.use("/api/network-reliability", networkReliabilityRouter);

// Layer 8 Sprint 1 — Reliable P2P Messaging (data plane): transports ALREADY-ENCRYPTED application
// messages with guaranteed-delivery semantics (reliable delivery, ordering, ACKs, retransmission,
// duplicate detection). The server is a BLIND store-and-forward relay (ciphertext only, never
// decrypts); the messaging engine runs peer-to-peer on the client. NO file transfer/media (Sprint 2).
app.use("/api/data-plane", dataPlaneRouter);

// Layer 8 Sprint 2 — Large Payload Transport Engine: efficiently transports large ENCRYPTED payloads
// (files, images, videos, voice notes, documents, binary) via fragmentation, flow control,
// backpressure, multiplexing, priority scheduling, and reassembly — on top of the reliable messaging
// data plane. The server is a BLIND chunk relay (opaque ciphertext only, never decrypts); the engine
// runs peer-to-peer on the client. NO live media (voice/video calls, streaming) — that is Layer 11.
app.use("/api/transport-engine", transportEngineRouter);

// Layer 8 Sprint 3 — Data Plane Reliability & Production Hardening: makes transfers reliable
// (interrupted-transfer recovery, resume-from-checkpoint, connection migration WiFi↔mobile, health
// monitoring, observability, security validation, protocol freeze). Carries NO payload/keys; recovery
// preserves the transfer checkpoint + crypto session. Completes Layer 8; Layer 9 (offline sync) builds
// on the frozen Data-Plane interfaces.
app.use("/api/transport-reliability", transportReliabilityRouter);

// Layer 9 Sprint 1 — Offline Synchronization Engine: securely synchronizes ENCRYPTED application state
// (messages, conversations, delivery, read receipts, attachment/transfer/device metadata) across a
// user's devices by computing deltas (what's missing) + deterministic plans (how to sync) and running
// resumable sessions. Reasons over VERSION METADATA only (no plaintext/keys); moves no bytes (Layer 8
// does). NO conflict resolution / merge / consensus / group sync — that is Sprint 2.
app.use("/api/synchronization", synchronizationRouter);

// Layer 9 Sprint 2 — State Replication & Conflict Resolution: every device is a secure encrypted
// REPLICA; keeps replicas eventually consistent by comparing them, resolving conflicts (LWW / server-
// authority / merge / custom), applying deterministic merges (read-receipt union, delivery max-state,
// attachment/metadata field-merge), replicating deltas (replay-protected), and resuming interrupted
// sync. Reasons over version metadata only (no plaintext/keys). NO consensus / CRDTs / vector clocks.
app.use("/api/replication", replicationRouter);

// Layer 9 Sprint 3 — Synchronization Reliability & Production Hardening: makes synchronization reliable
// (interrupted-sync/device-crash/app-restart recovery, resume-from-checkpoint, health monitoring,
// replica-drift tracking, retry policies, observability, security validation, protocol freeze). Carries
// NO content/keys; recovery preserves replica consistency. Completes Layer 9; Layer 10 (secure group
// communication) builds on the frozen sync interfaces.
app.use("/api/sync-reliability", syncReliabilityRouter);

// Layer 10 Sprint 1 — Group Foundation & Membership Management: treats a Group as a FIRST-CLASS
// distributed entity with its own identity, lifecycle, membership (invite/accept/reject, join/approve,
// leave/remove/ban/mute, transfer ownership), role-based access control, a configurable permission
// system, versioned metadata, a per-facet version vector, and a reconcilable replica snapshot. Reasons
// over control-plane metadata only (no message content / keys). Additive + independent of the Layer 1
// `/api/groups` chat routes. NO group messaging / encryption / fan-out — those consume this in Sprint 2.
app.use("/api/group-management", groupManagementRouter);

// Layer 10 Sprint 2 — Group Communication Engine: turns the Sprint-1 Group Foundation into a live,
// end-to-end-encrypted channel — secure group messaging, group key management + membership rekeying
// (fresh secret on departure), intelligent multi-device fan-out, group synchronization, and offline-
// member support. Reuses Layer 5 (HKDF key hierarchy), Layer 8 (reliable messaging fan-out), Layer 9
// (synchronization delta model), and the Sprint-1 Group Manager (membership). BLIND relay: stores key
// METADATA (fingerprints/versions) + OPAQUE ciphertext only — never keys/plaintext. NO monitoring/
// hardening (Sprint 3) or read receipts (Sprint 4) — its events are the seam those consume.
app.use("/api/group-communication", groupCommunicationRouter);

// Layer 10 Sprint 3 — Group Reliability & Production Hardening: makes the Group Communication platform
// production-grade — interrupted-messaging / failed-fan-out / rekey / membership / replica / sync /
// offline recovery, continuous health monitoring (per-operation + per-group), configurable retry
// policies, observability (metrics + Prometheus/OTel hooks), security validation + audit, and a protocol
// freeze declaring the stable interfaces + Sprint 4 extension points. Carries NO content/keys; recovery
// preserves consistency (the monotonic operation checkpoint). Completes Layer 10; Sprint 4 (Group
// Delivery & Read Receipt Engine) builds on the frozen interfaces + delivery-leg + event seams.
app.use("/api/group-reliability", groupReliabilityRouter);

// Layer 10 Sprint 4 — Group Delivery Intelligence & Receipt Aggregation: an INDEPENDENT subsystem on top
// of the frozen group platform. Tracks per-member delivery + read state (multi-device, deduplicated),
// aggregates them INCREMENTALLY (O(1) receipt reads, no per-member scans), and serves WhatsApp-style
// ✓ / ✓✓ / ✓✓-blue indicators + delivery analytics. Auto-driven by the Sprint-2 delivery/received events;
// carries NO content/keys. Configurable receipt policy (exclusions / read-receipts-off / privacy hooks)
// is the seam for future privacy + business rules without architecture changes.
app.use("/api/group-receipts", groupReceiptRouter);

// Layer 11 Sprint 1 — Secure Media Pipeline: a reusable platform that securely handles ENCRYPTED media
// through its whole lifecycle (upload, download, per-file encryption, metadata, integrity verification,
// upload/download orchestration) with a PLUGGABLE storage provider. The server is a BLIND relay: the
// client encrypts device-side (per-file key, never sent) and uploads OPAQUE ciphertext + non-secret
// iv/tag + a key fingerprint; the pipeline stores the blob, verifies integrity, and serves opaque
// ciphertext for device-side decryption. Reuses Layer 5 (crypto), 8 (transport), 9 (sync), 10 (group).
// NO streaming / progressive transfers / thumbnails / previews (Sprint 2).
app.use("/api/media", mediaRouter);

// Layer 11 Sprint 2 — Distributed Media Delivery & Streaming: delivers encrypted media efficiently on
// top of the frozen Sprint-1 pipeline — progressive downloads/uploads (windowed chunks + resume),
// streaming sessions (buffer + seek + pause/resume), async pluggable thumbnail + preview generation,
// multi-device media synchronization (reuses Layer 9 delta), and transfer optimization (priorities +
// parallel scheduling + bandwidth metrics). BLIND relay: moves OPAQUE ciphertext in chunks (per-chunk
// hash preserves integrity) + control-plane metadata only — never decrypts/keys. Reuses Layer 8
// (chunking) + Layer 9 (sync). NO voice/video/screen-share/real-time/codecs (Sprint 3 / Layer 12).
app.use("/api/media-delivery", mediaDeliveryRouter);

// Layer 11 Sprint 3 — Media Reliability & Production Hardening: makes the Secure Media Platform
// production-grade — interrupted-upload / interrupted-download / streaming / pipeline / storage / sync
// recovery (resume from a monotonic checkpoint preserving integrity + metadata consistency), health
// monitoring (per-operation + per-media), configurable retry policies, observability (MediaMetrics
// Prometheus/OTel + cache-hit-rate), a hot-metadata cache, security validation + audit, and a protocol
// freeze declaring the stable interfaces + Layer 12 extension points. Carries NO content/keys. Completes
// Layer 11; Layer 12 (Distributed Hybrid Architecture) builds on the frozen interfaces + seams.
app.use("/api/media-reliability", mediaReliabilityRouter);

// Layer 12 Sprint 1 — Distributed Communication Fabric: the ORCHESTRATION layer of the whole platform and
// the single entry point for every communication request. It coordinates the frozen lower layers
// (security, connectivity, messaging, media, synchronization, groups, delivery) WITHOUT reimplementing
// them: a request builds an immutable context, is shaped by configurable policies, and is routed by a
// pluggable Decision Engine to a strategy + execution plan, which the orchestrator delegates to registered
// subsystem adapters. Reasons over control-plane metadata ONLY (no content/keys); a no-content scan guards
// every persist. Sprint 2 (intelligent/adaptive routing) consumes this sprint's events + rule/route/policy
// seams. Placeholders (relay + hybrid strategies) are declared but inert.
app.use("/api/communication-fabric", communicationFabricRouter);

// Layer 12 Sprint 2 — Intelligent Routing & Adaptive Communication: turns the Fabric's deterministic
// decision into an ADAPTIVE one. It collects capability profiles, analyzes the communication + network
// posture, scores candidate routes with pluggable scorers (transport availability / security / capability
// match / policy / cost / sync — plus inert Sprint-3 placeholders for network quality / latency /
// bandwidth), selects the optimal strategy WITHOUT hardcoded conditionals, and produces explainable
// execution + deterministic fallback plans. Policy hooks (data-saver / battery-saver / enterprise /
// security) influence scoring. Reasons over control-plane metadata + declared capability + injected
// availability only (NO probing / ML this sprint). The same integration also makes /api/communication-
// fabric intelligent. Sprint 3 (resource optimization / QoS) consumes its events + activates the reserved
// scoring dimensions.
app.use("/api/adaptive-routing", adaptiveRoutingRouter);

// Connect to MongoDB
console.log("Attempting to connect to MongoDB...");
await connectDB();
console.log("MongoDB connection attempt finished.");

// Layer 6 Sprint 2 — start the presence heartbeat monitor (periodic expiry sweeps). The timer is
// unref'd so it never keeps the process alive on its own.
heartbeatMonitor.start();
console.log("Presence heartbeat monitor started.");

// Layer 8 Sprint 3 — start the transport stall monitor (periodic no-progress sweeps → recovery). The
// timer is unref'd so it never keeps the process alive on its own.
stallMonitor.start();
console.log("Transport reliability stall monitor started.");

// Layer 9 Sprint 3 — start the synchronization stall monitor (no-progress sweeps → recovery). Unref'd.
syncStallMonitor.start();
console.log("Synchronization reliability stall monitor started.");

// Layer 10 Sprint 3 — start the group-operation stall monitor (no-progress sweeps → recovery). Unref'd.
groupStallMonitor.start();
console.log("Group reliability stall monitor started.");

// Layer 11 Sprint 3 — start the media-operation stall monitor (no-progress sweeps → recovery). Unref'd.
mediaStallMonitor.start();
console.log("Media reliability stall monitor started.");

// Layer 7 Sprint 3 — start the connection reliability heartbeat monitor (periodic timeout sweeps →
// automatic recovery). Timer is unref'd.
reliabilityHeartbeatMonitor.start();
console.log("Connection reliability heartbeat monitor started.");

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

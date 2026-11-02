# REPOSITORY INVENTORY
**Audit Date:** November 2026  
**Auditor:** Multi-Disciplinary Production Readiness Audit Team  
**Scope:** Distributed Secure Communication Platform (Layers 1–12, Client, Server, Crypto-SDK)

---

## 1. Executive Technology Inventory

| Dimension | Declared / Discovered Technology | Location & Configuration | Verified Status |
| :--- | :--- | :--- | :--- |
| **Backend Framework** | Node.js (v26.11.1), Express.js v5.1.0 (ESM) | [`server/server.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js), [`server/package.json`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/package.json) | Confirmed via code inspection |
| **Frontend Framework** | React 19.1.1, Vite 7.1.7, TailwindCSS v4.1.13 | [`client/src/App.jsx`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/src/App.jsx), [`client/package.json`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/package.json) | Confirmed via code inspection |
| **Programming Languages** | JavaScript (ESM, Node/Browser), TypeScript 5.6 (Crypto-SDK) | Entire codebase | Confirmed |
| **Primary Persistence** | MongoDB via Mongoose v8.18.3 | [`server/lib/db.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/db.js), [`server/models/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/models/) | In-memory repos used in tests; MongoDB driver present |
| **Cache / Presence Store** | Redis via `ioredis` v5.9.2 | [`server/lib/redis.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/redis.js) | Confirmed; fallback to localhost |
| **Real-Time Messaging** | Socket.io v4.8.1 (Server & Client) | [`server/server.js:L71`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js#L71), [`client/context/AuthContext.jsx`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/context/AuthContext.jsx) | Confirmed |
| **P2P Transport** | Simulated Data Plane & Relay Fallback (Pure JS) | [`server/data-plane/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/data-plane/), [`server/transport-engine/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/transport-engine/) | Pure JS simulation; no native WebRTC RTCDataChannel |
| **Relay Infrastructure** | Blind Store-and-Forward Express Routes | [`server/routes/dataPlaneRoute.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/routes/dataPlaneRoute.js) | Confirmed |
| **Cryptographic Primitives** | Node.js `node:crypto` (AES-256-GCM, X25519, Ed25519, HKDF, SHA-256) | [`crypto-sdk/src/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/crypto-sdk/src/), [`server/forward-secrecy/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/forward-secrecy/) | Confirmed |
| **State Synchronization** | In-memory & MongoDB Delta Sync Engine (Version vectors, LWW) | [`server/synchronization/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/synchronization/), [`server/replication/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/replication/) | Confirmed |
| **Media Storage** | Cloudinary v2.7.0 (Chat UI) + Pluggable Filesystem Provider (Layer 11) | [`server/controllers/messageController.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js), [`server/media-delivery/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/media-delivery/) | **CRITICAL GAP:** `server/media/` directory is missing! |
| **Deployment Manifests** | Vercel (`server/vercel.json`, `client/vercel.json`) | Root & subdirectories | Incompatible with stateful Socket.io / Redis |
| **Test Frameworks** | Node.js native test runner (`node --test`), Vitest (Crypto-SDK) | [`server/package.json:L12`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/package.json#L12) | 1,870 server tests executed |

---

## 2. Directory Structure & Layer Mapping

```
MERN-Stack-Chat-App/
├── client/                     # React 19 Frontend (Vite + TailwindCSS)
│   ├── src/components/         # ChatContainer, Sidebar, RightSidebar, CreateGroupModal
│   ├── src/context/            # AuthContext, ChatContext (Plaintext REST/Socket.io flow)
│   ├── src/lib/                # Client SDK bindings for Layers 3-12 (DISCONNECTED from UI)
│   └── vercel.json             # SPA static rewrite config
├── crypto-sdk/                 # Layer 2 Crypto SDK (TypeScript, Node >= 18)
│   ├── src/                    # AES-GCM, X25519, Ed25519, HKDF, Zeroization
│   └── tests/                  # Vitest test suites (Unverified locally: missing node_modules)
├── server/                     # Layer 1 Backend + Layers 3-12 Distributed Fabric
│   ├── controllers/            # Legacy Chat & Subsystem HTTP Handlers
│   ├── identity/ & device-trust/ & trust/   # Layer 3: Ed25519 Identities & QR Verification
│   ├── shs/ & secure-transport/# Layer 4: Secure Handshake System & Session Transport
│   ├── forward-secrecy/ & message-keys/     # Layer 5: Ratchet & Ephemeral Rekeying
│   ├── peer-discovery/ & presence/ & pdp/   # Layer 6: Discovery & Reachability
│   ├── network-discovery/ & network-reliability/ # Layer 7: STUN & Connection FSM
│   ├── data-plane/ & transport-engine/      # Layer 8: Reliable Data Plane
│   ├── synchronization/ & replication/      # Layer 9: Offline Delta Sync
│   ├── group/ & group-communication/        # Layer 10: Group E2EE & Receipt Tracking
│   ├── media-delivery/ & media-reliability/ # Layer 11: Chunked Transfer & Delivery
│   │   └── [MISSING] media/                 # MISSING Sprint 1 core media pipeline
│   ├── communication-fabric/ & adaptive-routing/ # Layer 12: Fabric & Scored Routing
│   ├── optimization/ & fabric-reliability/  # Layer 12: QoS, Circuit Breakers, Freeze
│   └── server.js               # 44 mounted API route groups + 7 background monitors
```

---

## 3. Discovered Discrepancies & Dead Code Analysis

1. **Missing Core Subsystem (`server/media/`):**
   - Declared in documentation (`LAYER11_SPRINT1_SECURE_MEDIA_PIPELINE.md`) and imported by `server/controllers/mediaController.js` and `server/media-delivery/tests/helpers.js`.
   - The directory does not exist on disk and was never committed to git.
   - **Impact:** Immediate crash on server startup if `/api/media` is imported; 3 test suites fail.

2. **UI vs. Fabric Decoupling (Facade Disconnect):**
   - The React UI in `client/src/components/ChatContainer.jsx` communicates exclusively through `/api/messages/send/:id` and `/api/groups/send/:id`.
   - None of the cryptographic ratchets, device trust verifications, or fabric routing in `client/src/lib/` are wired into the user interface.

3. **Database & Cache Coupling:**
   - `server/lib/db.js` performs a top-level `await mongoose.connect()`. Without `MONGODB_URI`, boot fails.
   - `server/lib/redis.js` defaults to `redis://localhost:6379`. In serverless environments (Vercel), connections fail unless configured.

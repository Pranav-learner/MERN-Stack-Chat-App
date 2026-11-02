# 💬 Realtime MERN Chat Application + P2P Reference Architecture

A production-engineered, real-time messaging platform built with the **MERN stack** (MongoDB, Express, React, Node.js), **Socket.io** for bidirectional communication, and **Redis** for resilient multi-device presence. 

Engineered for high reliability with bounded cursor pagination, idempotency deduplication, group authorization lifecycle enforcement, and graceful failure handling.

---

## 🌐 Live Demo & Deployment Status

- **Live Frontend (Vercel):** `https://chat-app-with-others.vercel.app` (or your configured Vercel URL)
- **Backend Health Check:** `https://<backend-host>/health` or `/api/health`
- **Hosting Architecture:** Vercel (React/Vite SPA Edge) + Render / Railway (Persistent Node.js & Socket.IO Web Service)

> [!WARNING]
> **Portfolio Demo Notice & Data Disclosure**  
> This demo deployment uses standard transport-level encryption (**HTTPS/WSS**). Message contents and media attachments are persisted in MongoDB and Cloudinary for demonstration purposes and are server-readable. **Do not enter sensitive passwords, financial data, or private personal information.**  
> A companion 12-layer Cryptographic SDK ([`crypto-sdk/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/crypto-sdk)) is included in this repository to showcase decentralized identity, key agreement, forward secrecy, and Double Ratchet algorithms as a standalone reference architecture.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Client ["Client Layer (React 19 + Vite)"]
        UI[Chat UI & Composer]
        AuthCtx[AuthContext / Token]
        ChatCtx[ChatContext / Idempotency]
        SocketClient[Socket.IO Client]
    end

    subgraph Edge ["Transport & Ingress"]
        TLS[HTTPS / WSS (TLS 1.3)]
        CORS[Production CORS Guard]
        RL[IP & Auth Rate Limiter]
    end

    subgraph Backend ["Persistent Backend (Node.js + Express)"]
        HTTPRouter[Express REST API]
        SocketServer[Socket.IO Server]
        AuthMW[JWT Auth Middleware]
        GroupAuth[Group BOLA & Membership Guard]
        Paginator[Cursor Pagination Engine]
    end

    subgraph Persistence ["Data & State Stores"]
        Mongo[(MongoDB Atlas)]
        Redis[(Redis Cloud / In-Memory Fallback)]
        Cloudinary[(Cloudinary Media CDN)]
    end

    UI --> ChatCtx --> SocketClient
    AuthCtx --> HTTPRouter
    SocketClient -->|WSS| TLS --> SocketServer
    HTTPRouter -->|HTTPS| TLS --> CORS --> RL --> AuthMW
    AuthMW --> GroupAuth --> Paginator --> Mongo
    SocketServer --> Redis
    HTTPRouter --> Cloudinary
```

---

## 🚀 Key Features

### 1. Real-Time Messaging & Delivery Guarantees
- **Persistent Socket.IO Engine:** Instant real-time private messaging with delivery acknowledgements.
- **Delivery Idempotency:** Outgoing messages attach client-generated UUIDs (`clientMessageId`); retries do not create duplicate database records.
- **Bounded Cursor-Based Pagination:** Efficient historical message retrieval using indexed `createdAt` cursors, eliminating duplicate message loops and bounded to a maximum page size of 100.
- **Multi-Tab Presence:** Redis set-based socket tracking ensures a user remains online across multiple tabs or devices until the final socket disconnects.

### 2. Group Messaging & Authorization
- **Group Lifecycle:** Create groups, invite members, accept/reject invites, leave groups, and admin member removal.
- **BOLA & Access Defenses:** Strict member verification on every read and write operation. Removing a member revokes access immediately.

### 3. Media Handling & Safety
- **Bounded Payloads:** 5MB image upload limit strictly enforced on both client (toast alert) and server (HTTP 400).
- **Graceful Provider Fallback:** Upstream Cloudinary failures return HTTP 502 Bad Gateway instead of unhandled server crashes.

### 4. Production Resilience
- **In-Memory Redis Fallback:** Zero-downtime socket mapping and presence even if Redis experiences a connection outage.
- **Graceful Shutdown:** Handles `SIGTERM` and `SIGINT` signals, closing HTTP listeners, Mongoose pools, and Redis clients cleanly.
- **Live Health Probes:** `/health`, `/api/health`, and `/api/status` expose real-time database, redis, and process uptime metrics.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, Vite, Tailwind CSS, Axios, Socket.io-client, React Hot Toast, Lucide React |
| **Backend** | Node.js (v20+), Express 5, Socket.IO 4, Mongoose 8, ioredis, Cloudinary, bcryptjs, jsonwebtoken |
| **Databases** | MongoDB Atlas (persistence), Redis Cloud / Upstash (presence & socket sessions) |
| **Reference SDK** | 12-layer Cryptographic SDK (`crypto-sdk/`) with TypeScript and Vitest |

---

## 🧪 Verified Test Coverage

The test suite runs against active code without mocks where appropriate, verifying all critical paths:

```
✔ Security & Core Workflows Suite (14/14 tests pass)
  - Multi-socket & Redis set tracking
  - Rate limiting on auth (HTTP 429 & Retry-After)
  - Production CORS origin policy
  - Group authorization & BOLA defenses
  - Socket handshake JWT validation
  - Bounded cursor pagination & chronological sorting
  - Delivery idempotency with clientMessageId
  - Group membership revocation lifecycle
  - 5MB media upload limit validation

✔ Complete Backend Test Suite (1,912/1,912 tests pass across 528 suites)
✔ Standalone Crypto SDK Tests (97/97 tests pass, TypeScript clean)
✔ Frontend Production Build (159 modules cleanly bundled in 3.5s)
```

---

## ⚙️ Local Development Setup

### 1. Prerequisites
- **Node.js** (v18.0.0 or higher)
- **MongoDB** (Local instance or MongoDB Atlas URI)
- **Redis** (Optional: local redis or Upstash URL; falls back to in-memory)

### 2. Clone & Install
```bash
git clone https://github.com/Pranav-learner/MERN-Stack-Chat-App.git
cd MERN-Stack-Chat-App

# Install backend dependencies
cd server
npm install

# Install frontend dependencies
cd ../client
npm install
```

### 3. Environment Configuration

**Backend (`server/.env`):**
```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/?retryWrites=true&w=majority
JWT_SECRET=your_super_secret_jwt_key
CLIENT_URL=http://localhost:5173
# Optional media & cache credentials
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
REDIS_URL=redis://localhost:6379
```

**Frontend (`client/.env`):**
```env
VITE_BACKEND_URL=http://localhost:5000
```

### 4. Run Locally

In separate terminal windows:

```bash
# Terminal 1: Start Backend (http://localhost:5000)
cd server
npm run server

# Terminal 2: Start Frontend (http://localhost:5173)
cd client
npm run dev
```

---

## 🚢 Production Deployment

Refer to the complete step-by-step guide in [`docs/audit/LIVE_DEPLOYMENT_GUIDE.md`](file:///home/pranav/Documents/MERN-Stack-Chat-App/docs/audit/LIVE_DEPLOYMENT_GUIDE.md).

- **Backend:** Host on **Render**, **Railway**, or **Fly.io** as a persistent Node.js Web Service with root directory `server/` and start command `npm start`.
- **Frontend:** Host on **Vercel** with root directory `client/`, build command `npm run build`, and environment variable `VITE_BACKEND_URL=https://<your-backend-domain>`.

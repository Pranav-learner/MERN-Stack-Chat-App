# PHASE 1 — REPOSITORY FINDINGS
**Audit & Remediation Phase:** Phase 1 (Baseline Restoration)  
**Date:** November 2026  
**Auditor / Engineer:** Senior Backend Engineer  

---

## 1. Verified Package Management & Dependency Baseline

| Subsystem | Directory | Declared Package Manager | Lockfile | Installation Status (`npm ci`) |
| :--- | :--- | :--- | :--- | :--- |
| **Backend Server** | `server/` | npm (Node >= 18) | [`server/package-lock.json`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/package-lock.json) | **Clean (163 packages installed)** |
| **Client Frontend** | `client/` | npm (Vite 7, React 19) | [`client/package-lock.json`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/package-lock.json) | **Clean (213 packages installed)** |
| **Crypto SDK** | `crypto-sdk/` | npm (TypeScript 5.6) | [`crypto-sdk/package-lock.json`](file:///home/pranav/Documents/MERN-Stack-Chat-App/crypto-sdk/package-lock.json) | **Clean (205 packages installed)** |

---

## 2. Diagnosis of Missing Media Subsystem (`server/media/`)

### Trace Analysis:
The audit investigated references across the codebase to `server/media/`:
1. [`server/controllers/mediaController.js:L21-L26`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/mediaController.js#L21-L26) imported:
   - `MediaManager` from `../media/manager/mediaManager.js`
   - `createMediaApi` from `../media/api/mediaApi.js`
   - `createMongoMediaRepository` from `../media/repository/mongoMediaRepository.js`
   - `createFilesystemStorageProvider` from `../media/providers/filesystemStorageProvider.js`
   - `MediaEventBus` from `../media/events/events.js`
   - `MediaError` from `../media/errors.js`
2. [`server/media-delivery/tests/helpers.js:L7-L10`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/media-delivery/tests/helpers.js#L7-L10) imported:
   - `MediaManager`, `createInMemoryMediaRepository`, `createInMemoryStorageProvider`, `generateMediaKey, encryptMedia, decryptMedia, mediaKeyFingerprint, sha256`
3. [`server/media-delivery/manager/mediaGateway.js:L18`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/media-delivery/manager/mediaGateway.js#L18) imported:
   - `sha256` from `../../media/encryption/mediaEncryption.js`
4. [`server/package.json:L12`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/package.json#L12) declared test pattern:
   - `"media/tests/**/*.test.js"`

### Git History Investigation:
- Git log inspection confirmed that `server/media/` was described in `LAYER11_SPRINT1_SECURE_MEDIA_PIPELINE.md` but was never committed to the git tree prior to the Sprint 2 and Sprint 3 commits.
- It was not intentionally deleted; it was omitted during repository staging.
- Because `server.js:L333` mounted `app.use("/api/media", mediaRouter)`, `server.js` was crashing on cold start with `ERR_MODULE_NOT_FOUND`.

---

## 3. Database & Redis Initialization Diagnostics

1. **MongoDB Boot Hazard:**
   - Previous implementation executed `await mongoose.connect(`${process.env.MONGODB_URI}/chat-app`)` unconditionally at root level in [`server/server.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js).
   - If `MONGODB_URI` was missing from `.env`, the URI evaluated to `"undefined/chat-app"`, throwing a fatal exception during boot.
2. **Redis Unhandled Errors & Blocking Operations:**
   - Previous [`server/lib/redis.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/redis.js) connected directly to `redis://localhost:6379` with default infinite retries.
   - When Redis was absent in local development or serverless environments, connection refused errors flooded stderr, and socket operations threw unhandled promise rejections.
   - `getOnlineUsers()` executed an $O(N)$ synchronous keyspace scan via `redis.keys("user:*")`.

---

## 4. Frontend & SDK Disconnect

1. **React UI Plaintext Operation:**
   - Inspection of [`client/src/components/ChatContainer.jsx`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/src/components/ChatContainer.jsx) and [`client/context/ChatContext.jsx`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/context/ChatContext.jsx) confirmed that standard messaging uses `/api/messages/send/:id` and `/api/groups/send/:groupId` with plaintext strings and Cloudinary image uploads.
   - The Layer 3–12 client modules in `client/src/lib/` are standalone SDK libraries that are not consumed by the React UI components.

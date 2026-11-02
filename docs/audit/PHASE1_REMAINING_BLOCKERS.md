# PHASE 1 — REMAINING BLOCKERS AND NEXT STEPS
**Audit & Remediation Phase:** Phase 1 (Baseline Restoration)  
**Date:** November 2026  
**Auditor / Engineer:** Senior Backend Engineer  

---

## 1. Scope Boundary: What Phase 1 Solved vs. What Remains

Phase 1 successfully resolved repository broken imports, restored server cold boot, fixed all failing test suites, verified the frontend build, and established a reproducible test baseline (1,898 tests passing in server, 97 passing in crypto-sdk).

The following engineering and security items remain intentionally out-of-scope for Phase 1 and represent the subsequent roadmap:

---

## 2. Itemized Technical Backlog for Subsequent Phases

### 1. Authentication Rate Limiting
- **Current State:** `/api/auth/login` and `/api/auth/signup` accept unrestricted POST requests.
- **Risk:** High (Automated credential stuffing and dictionary brute-force attacks).
- **Remediation Plan:** Mount `express-rate-limit` on the `/api/auth` router (e.g., maximum 5 login attempts per IP per 15-minute window).

### 2. WebSocket & CORS Security Hardening
- **Current State:** [`server/server.js:L73`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js#L73) and `server.js:L187` use `cors({ origin: "*" })`.
- **Risk:** Medium (Unrestricted cross-origin socket connection initiation).
- **Remediation Plan:** Restrict `origin` to the production frontend domain (e.g. `https://your-app.vercel.app`) when `process.env.NODE_ENV === "production"`.

### 3. Plaintext Persistence vs. Cryptographic Architecture
- **Current State:** The React UI in `client/` communicates over standard REST and Socket.IO endpoints, saving plaintext text strings and Cloudinary image URLs into MongoDB.
- **Key Distinction:** The repository contains a 12-layer cryptographic distributed communication fabric (Layers 2–12), but it currently operates as an independent backend engine and client SDK. The UI does not yet consume these encryption hooks.
- **Remediation Plan:** If E2EE in the UI is desired, wire `client/src/lib/secureTransport.js` into `client/context/ChatContext.jsx` to encrypt payloads before posting to `/api/messages/send`. For interview presentations, clearly describe the dual-tier architecture.

### 4. Database Query Pagination
- **Current State:** [`server/controllers/messageController.js:L30`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js#L30) executes `Message.find()` without a `limit()` or cursor.
- **Risk:** Medium (Large chat histories consume excessive memory and slow down rendering).
- **Remediation Plan:** Add pagination parameters (`?limit=50&before=<timestamp>`) with infinite scroll in the React frontend.

### 5. Deployment Infrastructure Selection
- **Current State:** `server/vercel.json` exists, but Vercel serverless functions drop persistent WebSockets and terminate background timer loops.
- **Recommended Action:**
  - Host frontend `client/` on **Vercel** (Vite SPA).
  - Host backend `server/` on **Render.com**, **Railway.app**, or a container VPS where Node.js runs as a persistent long-lived process.
  - Connect free-tier **MongoDB Atlas** (`MONGODB_URI`) and **Upstash Redis** (`REDIS_URL`).

---

## 3. Recommended Phase 2 Sequencing

1. **Step 1:** Mount rate limiting on authentication routes and restrict CORS in production.
2. **Step 2:** Add message pagination (`limit: 50`) to direct and group message queries.
3. **Step 3:** Deploy the backend to Render.com and frontend to Vercel, validating end-to-end live chat across two independent devices.

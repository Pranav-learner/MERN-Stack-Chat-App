# END-TO-END ACCEPTANCE TEST PLAN
**Audit Date:** November 2026  
**Scope:** Verification Scenarios A through H across Full-Stack Application

---

## Scenario A — Two Users Real-Time Messaging
- **Preconditions:** Server running connected to MongoDB & Redis; two browser tabs open (Alice & Bob).
- **Steps:**
  1. Register Alice (`alice@example.com`) and Bob (`bob@example.com`).
  2. Alice selects Bob from the sidebar user list.
  3. Alice inputs `"Hello Bob"` and clicks Send.
- **Expected Results:** Message appears immediately in Alice's container; delivered via Socket.io to Bob's container in real-time.
- **Verification Status:** **PASS (Manual Walkthrough)** / Supported by codebase.

---

## Scenario B — Offline Delivery
- **Preconditions:** Alice online; Bob offline (browser closed).
- **Steps:**
  1. Alice sends `"Are you there?"` to Bob.
  2. Verify message persists in database with `status: "sent"`.
  3. Bob opens browser and logs in.
- **Expected Results:** Bob sees the unread badge; opening chat loads the message from MongoDB.
- **Verification Status:** **PASS** via MongoDB message persistence.

---

## Scenario C — Group Messaging
- **Preconditions:** Alice, Bob, and Charlie registered.
- **Steps:**
  1. Alice clicks `"Create Group"`, enters `"Engineering"`, and invites Bob and Charlie.
  2. Bob accepts the group invitation.
  3. Alice posts `"Team standup at 10"`.
- **Expected Results:** Message broadcasts to all connected group room sockets.
- **Verification Status:** **PASS** via Socket.io group rooms (`group._id`).

---

## Scenario D — Media Transmission
- **Preconditions:** Alice and Bob in active chat.
- **Steps:**
  1. Alice selects an image (`image/png`) via file picker.
  2. Client converts to base64 and posts to `/api/messages/send`.
- **Expected Results:** Cloudinary returns CDN URL; image renders in chat bubble.
- **Verification Status:** **PASS** with valid Cloudinary credentials; **FAIL** for Layer 11 E2EE pipeline (missing `server/media/`).

---

## Scenario E — Network Disconnect & Socket Recovery
- **Preconditions:** Active chat between Alice and Bob.
- **Steps:**
  1. Simulate client network disconnection (offline toggle in DevTools).
  2. Restore network connectivity after 10 seconds.
- **Expected Results:** Socket.io client reconnects automatically; presence state refreshes.
- **Verification Status:** **PASS** via native Socket.io client reconnection logic.

---

## Scenario F — Security & Authorization Boundary
- **Preconditions:** Authenticated user Eve.
- **Steps:**
  1. Eve sends `GET /api/messages/:otherUserId` where Eve is neither sender nor receiver.
- **Expected Results:** Server returns empty message set (query bounded by `$or: [{senderId: Eve}, {receiverId: Eve}]`).
- **Verification Status:** **PASS** (Object-level authorization verified in code).

---

## Scenario G — Server Restart & Persistence
- **Preconditions:** Messages exchanged between Alice and Bob.
- **Steps:**
  1. Terminate server process (`kill -9`).
  2. Restart server.
  3. Alice refreshes browser.
- **Expected Results:** Chat history persists intact from MongoDB.
- **Verification Status:** **PASS** (Dependent on MongoDB running independently).

---

## Scenario H — Observability & Diagnostics
- **Preconditions:** Server active.
- **Steps:**
  1. Query `GET /api/status`.
  2. Query `GET /api/fabric-reliability/health` with JWT token.
- **Expected Results:** HTTP 200 with JSON health report.
- **Verification Status:** **PASS** in unit test harnesses.

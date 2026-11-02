# APPLICATION FUNCTIONALITY AUDIT
**Audit Date:** November 2026  
**Scope:** Core User Workflows, Data Persistence, Receipt Semantics, UI vs. Backend Integration

---

## 1. End-to-End Workflow Traceability Matrix

| Workflow | Entry Point (API / Socket) | Service / Controller | Persistence Layer | Authorization & Security | Actual Verification Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Registration** | `POST /api/auth/signup` | [`controllers/userController.js:L9`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/userController.js#L9) | MongoDB `User` model | Password hashed via bcryptjs (salt: 10) | Works with live MongoDB; unverified without DB |
| **Login** | `POST /api/auth/login` | [`controllers/userController.js:L53`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/userController.js#L53) | MongoDB `User` model | bcrypt comparison; sets `jwt` HTTP cookie | Works with live MongoDB; unverified without DB |
| **Session Expiration** | Cookie `maxAge: 7*24*3600*1000` | [`lib/utils.js:L6`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/utils.js#L6) | Ephemeral JWT token | `jwt.verify(token, process.env.JWT_SECRET)` | Insecure if `JWT_SECRET` undefined in dev |
| **Profile Update** | `PUT /api/auth/update-profile` | [`controllers/userController.js:L92`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/userController.js#L92) | MongoDB `User.findByIdAndUpdate` | `protectedRoute` middleware | Cloudinary image upload |
| **1-to-1 Chat** | `POST /api/messages/send/:id` | [`controllers/messageController.js:L59`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js#L59) | MongoDB `Message` model | `protectedRoute` | **Plaintext stored on MongoDB**; Socket.io event `newMessage` |
| **Group Chat** | `POST /api/groups/send/:groupId` | [`controllers/groupController.js:L186`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/groupController.js#L186) | MongoDB `Message` model (`groupId`) | Checks membership in `group.members` | **Plaintext stored on MongoDB**; Socket.io room broadcast |
| **Delivery Receipts** | Socket `messageStatusUpdate` | `messageController.js`, `ChatContext.jsx` | MongoDB `Message.status` | Authenticated socket | 1-on-1 updates status to `delivered`/`read` |
| **Media Uploads (UI)** | `POST /api/messages/send/:id` | `messageController.js` | Cloudinary CDN | `protectedRoute` | Unencrypted base64 images uploaded to Cloudinary |
| **E2EE Media (Layer 11)** | `POST /api/media` | [`controllers/mediaController.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/mediaController.js) | Pluggable FS Provider | `protectedRoute` | **BROKEN (Missing `server/media/`)** |

---

## 2. Group Receipt Requirements & Semantic Audit

The specified group delivery semantics require:
- **Single tick (✓):** Accepted by sender's messaging system.
- **Double tick (✓✓):** Delivered to *every* intended group recipient.
- **Blue double tick (✓✓ blue):** Read by *every* intended group recipient.

### Actual Implementation State:
1. **In the React UI ([`client/context/ChatContext.jsx:L155`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/context/ChatContext.jsx#L155)):**
   ```javascript
   // Groups don't have "seen" logic per member easily yet
   ```
   The UI does **not** track or display group delivery or read receipts.
2. **In Layer 10 Sprint 4 Backend ([`server/group-receipts/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/group-receipts/)):**
   - An advanced `GroupReceiptAggregator` exists with support for `ReceiptStatus.SENT`, `ReceiptStatus.DELIVERED`, and `ReceiptStatus.READ`.
   - It performs $O(1)$ multi-device aggregation with state transition rules.
   - **Gap:** This aggregator is isolated in `/api/group-receipts` and has zero connection to `/api/groups` or the frontend `ChatContext.jsx`.

---

## 3. Account Deletion and Offline Delivery

1. **Account Deletion:**
   - **NOT IMPLEMENTED** in `userController.js` or `userRoute.js`. Users cannot delete their accounts or purge stored messages.
2. **Offline Delivery:**
   - In 1-to-1 messaging, messages sent to an offline user are saved in MongoDB and retrieved via `GET /api/messages/:id` when the recipient opens the conversation.
   - No push notifications exist (WebPush / APNS / FCM).

---

## 4. Key Findings & Deficiencies

- **FINDING-APP-01 (High):** Plaintext Exposure in Database. The primary chat interface sends and persists raw plaintext strings in MongoDB.
- **FINDING-APP-02 (Medium):** Missing Account Deletion workflow (GDPR/Privacy non-compliance).
- **FINDING-APP-03 (Medium):** Group receipt semantics completely unrendered in the client UI.

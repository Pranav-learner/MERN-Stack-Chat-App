# API AND APPLICATION SECURITY AUDIT
**Audit Date:** November 2026  
**Scope:** 44 Mounted Route Groups, Authentication Middleware, Rate Limiting, CORS, Injection, BOLA/IDOR

---

## 1. Route Classification Matrix (44 Route Groups)

| Category | Route Groups | Authentication | Rate Limiting | Input Validation | Sensitive Data Exposure |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Public / Status** | `/api/status` | Public | None | None | None |
| **Legacy Auth** | `/api/auth` (signup, login, logout) | Public (Login/Signup) | **None (Brute Force Risk)** | Manual `if (!email)` | Minimal |
| **Legacy Chat** | `/api/messages`, `/api/groups` | `protectedRoute` (JWT) | None | Minimal | High (Plaintext returned) |
| **Layer 3 Identity**| `/api/identity`, `/api/devices`, `/api/trust`, `/api/session` | `protectedRoute` | None | Schema validators | Public keys / Fingerprints |
| **Layer 4 SHS** | `/api/handshake`, `/api/key-agreement`, `/api/secure-session`, `/api/messaging-session`, `/api/secure-transport` | `protectedRoute` | Extension point | Handshake validators | Ephemeral public keys |
| **Layer 5 FS** | `/api/session-evolution`, `/api/forward-secrecy`, `/api/auto-rekey`, `/api/key-hierarchy`, `/api/message-keys`, `/api/crypto-hardening` | `protectedRoute` | Extension point | Cycle-safe validators | Key fingerprints only |
| **Layer 6 Network** | `/api/discovery`, `/api/presence`, `/api/capabilities`, `/api/pdp`, `/api/endpoint-selection`, `/api/networking-hardening` | `protectedRoute` | Extension point | Network profile validators | Presence status & IP ports |
| **Layer 7 NAT** | `/api/network-discovery`, `/api/network-reliability` | `protectedRoute` | Extension point | Candidate validators | NAT / STUN candidates |
| **Layer 8 Data** | `/api/data-plane`, `/api/transport-engine`, `/api/transport-reliability` | `protectedRoute` | Extension point | Chunk validators | Ciphertext only |
| **Layer 9 Sync** | `/api/synchronization`, `/api/replication`, `/api/sync-reliability` | `protectedRoute` | Extension point | Delta validators | Version vectors only |
| **Layer 10 Group**| `/api/group-management`, `/api/group-communication`, `/api/group-reliability`, `/api/group-receipts` | `protectedRoute` | Extension point | Role & receipt validators| Group metadata & vectors |
| **Layer 11 Media**| `/api/media` (**BROKEN**), `/api/media-delivery`, `/api/media-reliability` | `protectedRoute` | Extension point | Header validators | Ciphertext / Previews |
| **Layer 12 Fabric**| `/api/communication-fabric`, `/api/adaptive-routing`, `/api/optimization`, `/api/fabric-reliability` | `protectedRoute` | Circuit breaker / Extension point | Context validators | Control plane metrics |

---

## 2. Defensive Vulnerability Assessment

### 1. Brute Force & Rate Limiting Deficiency
- **Finding ID:** `FINDING-SEC-01` (Severity: High)
- **Location:** [`server/controllers/userController.js:L53`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/userController.js#L53) (`login`)
- **Vulnerability:** Neither `/api/auth/login` nor `/api/auth/signup` employs rate limiting. An automated dictionary attack or credential stuffing can be executed against user accounts without throttling.

### 2. Overly Permissive CORS Configuration
- **Finding ID:** `FINDING-SEC-02` (Severity: Medium)
- **Location:** [`server/server.js:L73`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js#L73) and `server.js:L186`
- **Vulnerability:**
  ```javascript
  app.use(cors()); // Defaults to origin: *
  export const io = new Server(server, { cors: { origin: "*" } });
  ```
  Permitting all origins with credentials enabled poses security risks for cross-origin attacks in production environments.

### 3. Object-Level Authorization (BOLA/IDOR) Review
- **Direct Message Access:** [`messageController.js:L30`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js#L30) restricts queries to `{ $or: [{ senderId: myId, receiverId: peerId }, { senderId: peerId, receiverId: myId }] }`. A user cannot read arbitrary third-party messages by tampering with the URL parameter.
- **Group Message Access:** [`groupController.js:L163`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/groupController.js#L163) explicitly verifies that `group.members.includes(userId)`. Non-members are rejected with HTTP 403.

---

## 3. Summary of Security Posture

The application implements adequate user-level isolation in the legacy controllers and strict control-plane schema validation across Layers 3–12. However, the absence of rate limiting and the use of wildcard CORS represent critical gaps for internet exposure.

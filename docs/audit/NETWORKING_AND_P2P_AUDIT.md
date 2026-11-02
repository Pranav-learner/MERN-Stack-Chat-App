# NETWORKING AND P2P AUDIT
**Audit Date:** November 2026  
**Scope:** Peer Discovery, NAT Traversal, STUN/TURN Assumptions, P2P vs. Relay Transport

---

## 1. Networking Architecture (Layers 6, 7, 8)

| Layer | Subsystem | Declared Function | Actual Implementation Mechanism |
| :--- | :--- | :--- | :--- |
| **Layer 6** | Peer Discovery & PDP | Peer endpoint lookup & Connection Planning | In-memory registry & REST endpoints (`/api/discovery`, `/api/pdp`) |
| **Layer 6** | Real-Time Presence | Reachability & status transitions | Socket.io events + periodic heartbeat monitor (`server.js:L405`) |
| **Layer 7** | NAT Traversal & STUN | STUN candidate harvesting (host, srflx) | Abstract candidate models; no actual UDP STUN protocol socket |
| **Layer 7** | Connection Reliability | FSM connection tracking & recovery | JavaScript FSM (`DISCONNECTED` $\leftrightarrow$ `CONNECTED`) |
| **Layer 8** | P2P Data Plane | Reliable transport, chunking, flow control | Application-level chunking and ACK simulation |
| **Layer 8** | Relay Fallback | Blind store-and-forward relay | Express HTTP routes (`/api/data-plane/relay`) |

---

## 2. P2P Reality vs. Simulated Abstraction

### 1. Absence of Native WebRTC:
While documentation and types reference ICE candidates, STUN servers, and P2P data channels, **there is no WebRTC `RTCPeerConnection` implementation in the frontend or backend**:
- In `client/src/lib/transport.js` and `server/data-plane/`, connections are logical session IDs routed over HTTP and Socket.io.
- No direct peer-to-peer UDP/TCP packets are exchanged between client IP addresses.

### 2. Relay Dependency:
Every "P2P" data transfer actually operates in **Relay Fallback Mode**:
- Chunks and messages are posted to the server via Express routes.
- The server buffers and forwards the chunks to the recipient via Socket.io or polling.
- This means the platform's scalability is bound by the backend server's network bandwidth and I/O capacity, not decentralized peer bandwidth.

---

## 3. Findings & Operational Requirements

- **FINDING-NET-01 (High):** Simulated P2P Layer. The project does not establish true peer-to-peer data channels across the public internet. All traffic traverses the central server relay.
- **FINDING-NET-02 (Medium):** Missing STUN/TURN Infrastructure. If true WebRTC P2P is intended in the future, public STUN/TURN servers (e.g., Coturn) and credentials must be provisioned.

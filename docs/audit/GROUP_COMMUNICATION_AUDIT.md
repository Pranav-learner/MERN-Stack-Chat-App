# GROUP COMMUNICATION AUDIT
**Audit Date:** November 2026  
**Scope:** Group Foundation, Membership Lifecycle, Group Key Management, Fan-Out, Receipts

---

## 1. Group Communication Architecture (Layer 10)

Layer 10 structures groups as first-class distributed cryptographic entities:

1. **RBAC & Governance:** Roles (`OWNER`, `ADMIN`, `MEMBER`) govern invite creation, member removal, and policy updates.
2. **Group Key Management:**
   - Group Epochs: Group keys are versioned by epoch (`epoch: 0, 1, 2...`).
   - Forward Secrecy on Departure: When a member leaves or is removed, the group controller triggers an automatic epoch advance (`rotateGroupKey()`). A new group secret is derived and distributed individually to the remaining members via pairwise encrypted channels. The removed member cannot decrypt subsequent messages.
3. **Multi-Device Fan-Out:**
   - Messages are packaged into per-recipient or per-device delivery legs.
   - Offline recipients have pending delivery records queued until reconnect.
4. **Receipt Aggregation (Layer 10 Sprint 4):**
   - Tracks granular receipt vectors per member device.
   - WhatsApp-style indicators:
     - `SENT`: Server acknowledged sender.
     - `DELIVERED`: Delivered to all online member devices.
     - `READ`: Marked read by all members.

---

## 2. Comparison: Layer 10 Architecture vs. Legacy Chat Implementation

| Capability | Layer 10 Advanced Architecture | Legacy Group Chat (`/api/groups`) |
| :--- | :--- | :--- |
| **Encryption** | Ephemeral epoch group keys (E2EE) | **Unencrypted Plaintext** in MongoDB |
| **Member Removal Rekeying** | Immediate epoch rotation | None (removed users simply leave DB array) |
| **Delivery Receipts** | Incremental $O(1)$ multi-device aggregation | None (comment in UI: "no seen logic yet") |
| **Offline Queuing** | Multi-device delta queue | Rely on MongoDB chat history query |
| **UI Integration** | **None (Isolated API endpoints)** | **100% active in React UI** |

---

## 3. Key Findings

- **FINDING-GRP-01 (High):** Plaintext Group Storage. Group messages sent in the application UI bypass Layer 10 encryption and are stored as cleartext in the MongoDB `messages` collection.
- **FINDING-GRP-02 (Medium):** Absence of Group Receipt Indicators in UI. The UI fails to indicate whether group messages have been delivered or read by other members.

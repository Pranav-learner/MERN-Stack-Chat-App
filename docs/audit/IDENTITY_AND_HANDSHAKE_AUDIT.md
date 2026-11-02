# IDENTITY AND SECURE HANDSHAKE AUDIT
**Audit Date:** November 2026  
**Scope:** Device Registration, Multi-Device Trust, QR Safety Numbers, Ephemeral Handshake

---

## 1. Identity & Device Trust Architecture (Layer 3)

The identity subsystem models each user as a root cryptographic identity composed of one or more devices:

1. **Identity Keys:** Ed25519 keypair generated per device. The public key is registered with the server via `POST /api/identity/register`.
2. **Device Trust Lifecycle:**
   - States: `PROVISIONAL` $\rightarrow$ `VERIFIED` $\rightarrow$ `REVOKED`.
   - Revocation: Once marked `REVOKED`, requests bearing this device ID are rejected at the middleware level (`deviceTrustMiddleware.js`).
3. **Out-of-Band Trust Verification:**
   - **Deterministic Safety Numbers:** 60-digit symmetric fingerprint computed via HKDF-SHA256 over both peers' Ed25519 public keys, formatted in 12 groups of 5 digits.
   - **QR Verification Payloads:** Formatted with key fingerprints, timestamp, and signature, validated against key tampering.

---

## 2. Secure Handshake System (Layer 4)

The Secure Handshake System (SHS) implements an authenticated ephemeral Diffie-Hellman exchange:

```
Alice (Initiator)                                 Bob (Responder)
  |                                                     |
  | -------- HandshakeInit (ephemeral X25519 A) ------> |
  |                                                     |
  | <------- HandshakeChallenge (B + Signature_B) ------|
  |                                                     |
  | -------- HandshakeConfirm (Signature_A) ----------->|
  |                                                     |
  [Derive Session Keys: HKDF(ECDH(A, B), Transcript)]
```

### Protocol Robustness:
- **MITM Resistance:** Both parties sign the ephemeral key exchange transcript with their long-term Ed25519 identity keys. An active attacker cannot replace ephemeral keys without invalidating signatures.
- **Transcript Authentication:** Prevents replay and message injection during handshake negotiation.
- **Concurrency & Expiration:** Inactive handshakes expire after 60 seconds; in-memory map cleans up stale handshakes.

---

## 3. Findings & Operational Realities

- **FINDING-ID-01 (Medium):** No UI Interface for Device Verification. While the backend exposes comprehensive endpoints for safety numbers and QR codes (`/api/trust`), the React frontend has no UI screens or modals for displaying safety numbers, comparing fingerprints, or scanning QR codes.
- **FINDING-ID-02 (Low):** Device Key Persistence in Client. The client library `identityStore.js` uses browser `localStorage` by default, which is vulnerable to Cross-Site Scripting (XSS) extraction compared to `IndexedDB` with non-extractable WebCrypto keys.

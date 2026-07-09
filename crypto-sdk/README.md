# @securechat/crypto-sdk

**Layer 2 · Module 1 — Cryptography Foundation** for the Secure Hybrid
Distributed Messaging Platform.

A self-contained, chat-agnostic cryptographic toolkit. Future E2EE modules
(Identity Keys, Session Keys, Handshake, Forward Secrecy, Group/Media Encryption,
P2P Channels) import from this SDK instead of re-implementing cryptography.

> **Isolation:** This package touches nothing in `server/` or `client/`. No chat
> logic, API, DB schema, WebSocket, JWT, or auth is modified or imported. It has
> **zero runtime dependencies** — only the Node.js standard `crypto` module.

See [`docs/MODULE_1_FOUNDATION.md`](./docs/MODULE_1_FOUNDATION.md) for the full
design, algorithm rationale, security assumptions, and integration plan.

## Install & run

```bash
cd crypto-sdk
npm install        # dev-deps only (typescript, vitest)
npm test           # 86 tests
npm run build      # emit dist/ (JS + .d.ts)
```

## What's inside

| Capability | Algorithm | Entry points |
|---|---|---|
| Secure random | OS CSPRNG | `randomBytes`, `generateNonce`, `randomId`, `uuid` |
| Hashing | SHA-256/384/512, BLAKE2b | `sha256`, `hash`, `hashFile` |
| Key derivation | HKDF (RFC 5869), scrypt | `hkdf`, `deriveKeyFromPassword` |
| Symmetric AEAD | AES-256-GCM | `encrypt`, `decrypt` |
| Key agreement | X25519 (ECDH) | `generateKeyPair`, `deriveSharedSecret` |
| Signatures | Ed25519 | `generateSigningKeyPair`, `sign`, `verify` |
| Value objects | — | `SymmetricKey`, `PublicKey`/`PrivateKey`/`KeyPair`, `SharedSecret`, `Signature`, `EncryptedPayload` |
| Encoding | base64/base64url/hex/utf-8 | `toBase64`, `toHex`, `utf8ToBytes`, … |
| Errors | typed hierarchy | `CryptoError` + 12 subclasses |

## Quick start

```ts
import {
  generateKeyPair, deriveSharedSecret,
  generateSigningKeyPair, sign, verify,
  encrypt, decrypt, bytesToUtf8,
} from "@securechat/crypto-sdk";

// 1. Two parties agree on a shared secret (X25519) and derive a key (HKDF).
const alice = generateKeyPair();
const bob = generateKeyPair();
const keyA = deriveSharedSecret(alice.privateKey, bob.publicKey).deriveKey({ info: "demo:v1" });
const keyB = deriveSharedSecret(bob.privateKey, alice.publicKey).deriveKey({ info: "demo:v1" });

// 2. Authenticated encryption (AES-256-GCM).
const payload = encrypt(keyA, "hello bob");
console.log(bytesToUtf8(decrypt(keyB, payload))); // "hello bob"

// 3. Serialize the envelope for storage/transport.
const wire = payload.serialize();                 // JSON string

// 4. Sign & verify (Ed25519).
const id = generateSigningKeyPair();
const sig = sign(id.privateKey, wire);
console.log(verify(id.publicKey, wire, sig));      // true
```

## Error handling

```ts
import { decrypt, DecryptionError, CryptoError } from "@securechat/crypto-sdk";

try {
  decrypt(key, payload);
} catch (err) {
  if (err instanceof DecryptionError) {
    // tampered ciphertext / wrong key / wrong nonce / wrong AAD — reject
  } else if (err instanceof CryptoError) {
    console.error(err.code, err.message);
  }
}
```

## Guarantees & scope

- ✅ Modern, audited primitives (OpenSSL via Node `crypto`); **no hand-rolled crypto**.
- ✅ Strong typing + JSDoc + examples on every public API.
- ✅ 86 unit/integration tests (wrong key, tampering, wrong nonce, large/binary/UTF-8 payloads, RFC/NIST vectors).
- ⛔ No protocol, no session/ratchet, no key storage — those are **future modules**.

License: ISC.

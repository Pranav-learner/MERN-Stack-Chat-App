# @securechat/crypto-engine

**Layer 2 · Sprint 3 — Cryptographic Engine**, built on
[`@securechat/crypto-sdk`](../README.md) (Sprint 1, unchanged).

The feature-complete, reusable crypto engine future layers consume instead of
low-level crypto calls: symmetric + streaming/file encryption, a signature &
payload framework, key derivation, integrity checks, benchmarks, and security
utilities.

> **Scope:** a standalone cryptographic SDK. No chat, transport, auth, JWT,
> MongoDB, Redis, Socket.IO, handshake, identity keys, or Signal protocol. See
> [`docs/MODULE_3_CRYPTO_ENGINE.md`](./docs/MODULE_3_CRYPTO_ENGINE.md).

## Install & run

```bash
cd crypto-sdk/crypto-engine
npm install        # links @securechat/crypto-sdk (file:..) + dev-deps
npm test           # 81 tests
npm run build      # emit dist/ (build the SDK first: cd .. && npm run build)
```

## What's inside

| Area | Pieces |
|---|---|
| **Symmetric** | `SymmetricEngine` (AES-256-GCM AEAD), `encryptData`/`decryptData`, streaming chunk primitives |
| **Asymmetric** | `AsymmetricEngine` — X25519 agreement, small-order-point rejection, `fingerprint`, constant-time compare |
| **Signatures** | `SignatureEngine` — Ed25519 sign/verify, attached & detached `SignedPayload` |
| **Key derivation** | `MasterKey`, `KeyDerivation` (context/purpose separation), `deriveSessionKey` |
| **Payloads** | `EncryptedBuffer`, `SignedPayload`, `EncryptedFile`, `EncryptedAttachment` |
| **Files** | `FileEncryptor` — chunk-based buffer + streaming, reorder/truncation-safe |
| **Integrity** | `computeChecksum`/`verifyChecksum`, `IntegrityVerifier` (non-throwing) |
| **Benchmarks** | `benchmark`, `benchmarkEncryption/Decryption/Signing/Verification`, `sampleMemory` |
| **Security** | `SecureBuffer` (auto-wipe via `using`), `analyzeRandomness`, `toBytes`/`assertBinary` |
| **Errors** | `CryptoEngineError` family (extends the SDK's `CryptoError`) |

## Quick start

```ts
import {
  SymmetricEngine, FileEncryptor, SignatureEngine, AsymmetricEngine, KeyDerivation,
} from "@securechat/crypto-engine";
import { generateSigningKeyPair, bytesToUtf8 } from "@securechat/crypto-sdk";

// Derive a session key and encrypt.
const key = KeyDerivation.random().deriveSessionKey("peer-42");
const payload = new SymmetricEngine(key).encrypt("hello");
bytesToUtf8(new SymmetricEngine(key).decrypt(payload)); // "hello"

// Chunked file encryption (buffer or stream).
const fe = new FileEncryptor();
const enc = fe.encryptBuffer(new Uint8Array([1, 2, 3]), key, { metadata: { contentType: "application/octet-stream" } });
fe.decryptBuffer(enc, key); // Uint8Array([1,2,3])

// Detached signature.
const kp = generateSigningKeyPair();
const se = new SignatureEngine();
const sig = se.signDetached(kp.privateKey, enc.serialize());
se.verifyPayload(kp.publicKey, sig, enc.serialize()); // true

// Key agreement with validation.
const a = new AsymmetricEngine();
const alice = a.generateKeyAgreementKeyPair();
const bob = a.generateKeyAgreementKeyPair();
const shared = a.agree(alice.privateKey, bob.publicKey); // rejects small-order keys
```

## Streaming (memory-bounded)

```ts
const fe = new FileEncryptor({ chunkSize: 64 * 1024 });
const frames = fe.encryptStream(sourceAsyncIterable, key);   // header + chunk frames
for await (const plaintext of fe.decryptStream(frames, key)) sink.write(plaintext);
```

License: ISC.

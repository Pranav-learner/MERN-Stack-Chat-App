# @securechat/key-management

**Layer 2 · Sprint 2 — Key Management System**, built on top of
[`@securechat/crypto-sdk`](../README.md) (Sprint 1, unchanged).

Manages the full key lifecycle behind clean, swappable abstractions: storage,
caching, repositories, metadata, serialization, validation, and rotation.

> **Scope:** manages keys **only**. No message encryption, no handshake, no Signal
> protocol, and no coupling to chat / REST / WebSockets / MongoDB / auth. See
> [`docs/MODULE_2_KEY_MANAGEMENT.md`](./docs/MODULE_2_KEY_MANAGEMENT.md) for the
> full design, security assumptions, limitations, and integration plan.

## Install & run

```bash
cd crypto-sdk/key-management
npm install        # links @securechat/crypto-sdk (file:..) + dev-deps
npm test           # 81 tests
npm run build      # emit dist/ (build the SDK first: cd .. && npm run build)
```

## What's inside

| Area              | Pieces                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Manager**       | `KeyManager` — generate / store / get / import / export / replace / rotate / delete / validate / expire / recover |
| **Model**         | `ManagedKey` (metadata + live SDK material)                                                                       |
| **Metadata**      | `createKeyMetadata`, `computeFingerprint`, expiry helpers                                                         |
| **Serialization** | `KeySerializer` — JSON / base64 / binary, versioned + SHA-256 integrity                                           |
| **Validation**    | `KeyValidator` — format, length, fingerprint, expiry                                                              |
| **Storage**       | `KeyStorage` + `MemoryStorage`, `SecureStorage` (encrypt-at-rest), `Database`/`Hardware`/`CloudKms` placeholders  |
| **Cache**         | `KeyCache` + `InMemoryKeyCache` (LRU + TTL + stats), `NoopKeyCache`                                               |
| **Repositories**  | `Identity`, `Session`, `SharedSecret` (+ `PreKey`, `SignedPreKey`, `OneTime`, `Group` — future-ready)             |
| **Rotation**      | policies (age/usage/expiry/composite/manual/never) + `RotationScheduler` + history                                |
| **Recovery**      | `RecoveryProvider` + `NoopRecoveryProvider` (future hook)                                                         |
| **Migration**     | `MigrationRegistry` (future format upgrades)                                                                      |
| **Errors**        | `KeyManagementError` + 11 typed subclasses                                                                        |

## Quick start

```ts
import { KeyManager } from "@securechat/key-management";

const km = new KeyManager();

// Generate & store a long-term identity key (Ed25519).
const identity = await km.generateIdentityKey({ owner: "user-1" });

// Export public-only (safe to distribute); import into another manager.
const pub = await km.exportKey(identity.keyId); // JSON string
const other = new KeyManager();
await other.importKey(pub);

// Rotate → new version linked to the old one; retrieve the lineage.
const { previous, current } = await km.rotateKey(identity.keyId);
console.log(previous.metadata.status); // "rotated"
console.log((await km.getHistory(current.keyId)).map((h) => h.version)); // [1, 2]
```

## Encrypted-at-rest storage

```ts
import { KeyManager, SecureStorage, MemoryStorage } from "@securechat/key-management";
import { SymmetricKey, deriveKeyFromPassword, randomBytes } from "@securechat/crypto-sdk";

const master = SymmetricKey.fromBytes(deriveKeyFromPassword("passphrase", randomBytes(16)));
const km = new KeyManager({ storage: new SecureStorage(new MemoryStorage(), master) });
// Key payloads are AES-256-GCM encrypted at rest; the API is unchanged.
```

## Custom rotation policy (evaluation only — never auto-rotates)

```ts
import { KeyManager, AgeBasedRotationPolicy } from "@securechat/key-management";

const km = new KeyManager();
const due = await km.evaluateRotation(new AgeBasedRotationPolicy(30 * 24 * 3600_000));
for (const d of due.filter((x) => x.shouldRotate)) await km.rotateKey(d.keyId);
```

## Error handling

```ts
import { KeyManager, KeyNotFoundError, KeyManagementError } from "@securechat/key-management";

try {
  await new KeyManager().getKey("missing");
} catch (err) {
  if (err instanceof KeyNotFoundError) {
    /* ... */
  } else if (err instanceof KeyManagementError) console.error(err.code, err.details);
}
```

License: ISC.

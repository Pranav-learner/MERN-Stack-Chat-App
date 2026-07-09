# Changelog — Crypto SDK (Layer 2)

All three packages are versioned together and follow [Semantic Versioning](https://semver.org).
The public API and serialized wire formats are **frozen at 1.0.0**.

## [1.0.0] — Layer 2 complete

### `@securechat/crypto-sdk` (Sprint 1 — Cryptography Foundation)

- Secure random (`randomBytes`, `generateNonce`, `randomId`, `uuid`, `randomInt`).
- Encoding (base64 / base64url / hex / utf-8), validated.
- Hashing (SHA-256/384/512, BLAKE2b, `hashFile`).
- KDF (HKDF, scrypt `deriveKeyFromPassword`).
- Symmetric AEAD (AES-256-GCM `encrypt`/`decrypt`).
- Asymmetric (X25519 `generateKeyPair`/`deriveSharedSecret`).
- Signatures (Ed25519 `sign`/`verify`).
- Value objects: `SymmetricKey`, `PublicKey`, `PrivateKey`, `KeyPair`,
  `SharedSecret`, `Signature`, `CipherText`, `EncryptedPayload` (format **v1**).
- Typed `CryptoError` hierarchy.

### `@securechat/key-management` (Sprint 2 — Key Management System)

- `KeyManager` lifecycle: generate/store/get/import/export/replace/rotate/delete/
  validate/expire/recover.
- Storage abstraction (`KeyStorage`) + `MemoryStorage`, `SecureStorage`
  (encrypt-at-rest), and placeholder backends.
- `InMemoryKeyCache` (LRU + TTL), typed repositories, `KeySerializer`
  (key format **v1** + integrity), `KeyValidator`, rotation framework, metadata,
  migration & recovery hooks.
- `KeyManagementError` hierarchy.

### `@securechat/crypto-engine` (Sprint 3 — Cryptographic Engine)

- `SymmetricEngine` + chunked/streaming primitives.
- `AsymmetricEngine` (agreement, small-order rejection, fingerprints, compare).
- `SignatureEngine` + `SignedPayload` (attached/detached, format **v1**).
- `MasterKey` / `KeyDerivation` (context + purpose separation).
- Payload models: `EncryptedBuffer`, `EncryptedFile`/`EncryptedAttachment`
  (format **v1**).
- `FileEncryptor` (chunked + streaming, reorder/truncation-safe).
- `IntegrityVerifier` + checksums; benchmark harness; `SecureBuffer` &
  security utils.
- `CryptoEngineError` hierarchy (extends `CryptoError`).

### Sprint 4 — Hardening & Stabilization (this release)

- **API freeze** at 1.0.0; SemVer policy documented (CRYPTO_SDK.md §4).
- **Tooling:** ESLint (flat config) + Prettier + EditorConfig covering all three
  packages; `npm run check` / `check:all`; coverage via `@vitest/coverage-v8`.
- **CI:** `.github/workflows/crypto-sdk.yml` (lint, format, typecheck, test, build
  on Node 18/20/22; coverage job).
- **Advanced tests:** property-based/randomized, malformed-input fuzzing, and
  performance-regression guards added (SDK + engine). Total **265 tests**.
- **Docs:** `CRYPTO_SDK.md` (unified reference + Mermaid diagrams), `SECURITY.md`
  (review + assumptions), `INTEGRATION.md` (Layer 3 extension points), this
  changelog. Whole stack formatted to a single style.
- **No functional/behavioural changes**; no breaking changes. All prior tests
  remain green.

### Compatibility notes

- Serialized formats are versioned; a future format change ships a migration, not
  a break (`MigrationRegistry` in key-management; version fields elsewhere).
- Additive exports/optional params are minor releases; signature/return-type/enum/
  wire-format changes are major.

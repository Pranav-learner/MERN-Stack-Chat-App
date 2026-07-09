# SECURITY.md — Crypto SDK Security Review (Sprint 4)

> Scope: the Layer 2 Crypto SDK stack (`crypto-sdk`, `key-management`,
> `crypto-engine`). This is a design/implementation review and a statement of
> assumptions — not a third-party audit. It documents what was checked, the
> conclusion, and every assumption a consumer inherits.

## 1. Threat model & scope

The SDK provides cryptographic primitives and helpers. It assumes:

- The host OS CSPRNG and OpenSSL (via Node `crypto`) are correct and uncompromised.
- The process memory is trusted for the lifetime of a secret in use (no defense
  against a local attacker reading process RAM or core dumps).
- Callers are responsible for key **storage at rest**, **transport security
  (TLS)**, **access control**, and **protocol design** (handshake, ratchet,
  replay windows) — these are out of scope for Layer 2.

## 2. Review findings

| Area                              | Finding                                                                                                                                                                                                                                                                                  | Status                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Weak randomness**               | All randomness uses `crypto.randomBytes`/`randomInt`/`randomUUID`. No `Math.random()` anywhere. `analyzeRandomness` guards obviously-broken inputs (documented as a sanity check, not a certifier).                                                                                      | ✅ OK                     |
| **Unsafe APIs**                   | No unauthenticated cipher is exposed; symmetric encryption is AEAD-only with no "decrypt-without-verify" path. No ECB/CBC, no static IVs in the public API.                                                                                                                              | ✅ OK                     |
| **Nonce management**              | Single-shot AEAD uses a fresh random 96-bit nonce per call. Streaming/file derives a **unique per-stream key** (HKDF + random salt) so counter nonces cannot repeat under a key.                                                                                                         | ✅ OK (see assumption A1) |
| **Incorrect error handling**      | Decrypt/verify failures surface as typed errors/`false`; GCM tag failure → `DecryptionError`; malformed serialization → typed `*Error`, never an uncaught throw or silent success. Errors never contain secret bytes.                                                                    | ✅ OK                     |
| **Unsafe serialization**          | Deserializers parse JSON and validate structure/version/integrity; they never `eval`, never instantiate arbitrary types, and reject unknown formats/versions. KMS key blobs carry a SHA-256 integrity digest verified in constant time.                                                  | ✅ OK                     |
| **Key leakage / secret exposure** | `SymmetricKey`, `PrivateKey`, `SharedSecret`, `MasterKey`, `SecureBuffer` override `toJSON()`/`toString`-ish to redact (`"[SymmetricKey]"` etc.), so they don't leak via logs/`JSON.stringify`. Getters return **defensive copies**; internal buffers are never handed out by reference. | ✅ OK                     |
| **Improper validation**           | Public keys validated for length + curve; X25519 **small-order points rejected** (libsodium blacklist) and **all-zero shared secrets rejected**. Symmetric keys enforced to 32 bytes. Metadata/ciphertext structurally validated before use.                                             | ✅ OK                     |
| **Timing attacks**                | Tag/fingerprint/key/checksum comparisons use `crypto.timingSafeEqual` (`constantTimeEqual`). Length is compared first and is not itself hidden (standard, documented). AEAD/Ed25519 constant-time behaviour is inherited from OpenSSL.                                                   | ✅ OK (see A3)            |
| **Memory safety**                 | `wipe()` / `destroy()` / `SecureBuffer` zero buffers on demand and via `Symbol.dispose`. This is **best-effort** in V8 (the GC may copy first).                                                                                                                                          | ⚠ Best-effort (A2)        |
| **Dependency surface**            | crypto-sdk has **zero runtime dependencies** (Node stdlib only). key-management/crypto-engine depend only on crypto-sdk. No transitive supply-chain surface at runtime.                                                                                                                  | ✅ OK                     |
| **Injection / input execution**   | No dynamic code paths; inputs are only parsed/validated, never executed. Regexes are bounded.                                                                                                                                                                                            | ✅ OK                     |

## 3. Documented assumptions

- **A1 — Nonce uniqueness bound.** With random 96-bit GCM nonces, keep messages
  per key well below ~2³². High-volume single-key use should derive per-message
  keys (a Layer 3 concern). Streams already avoid this via per-stream keys.
- **A2 — Wiping is best-effort.** Zeroing sensitive buffers reduces, but does not
  eliminate, the window in which secrets sit in RAM. Not a defense against memory
  disclosure.
- **A3 — Length is not secret.** Constant-time comparisons hide _content_
  differences, not the _length_ of compared values; and ciphertext/ payload
  lengths reveal plaintext length (no padding scheme is imposed).
- **A4 — No PQ resistance.** X25519/Ed25519 are classical ECC; AES-256 gives a
  reasonable symmetric post-quantum margin. Migration is a future major version.
- **A5 — Caller owns key storage & transport.** The SDK produces/serializes keys;
  at-rest encryption is available (`SecureStorage`) but the master key and TLS are
  the caller's responsibility.
- **A6 — Password KDF cost.** `deriveKeyFromPassword`/`MasterKey.fromPassword`
  defaults (scrypt N=2¹⁵) suit interactive use; tune for your threat model.

## 4. Reporting

This is an internal library. Security issues should be filed against the Layer 2
tracker with a reproduction; do not embed secrets in reports.

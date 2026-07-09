/**
 * @module constants
 *
 * Centralised algorithm identifiers and byte-length constants for the Crypto SDK.
 *
 * These live in a dependency-free module so that every other module (keys,
 * symmetric, asymmetric, hashing, …) can import them without creating circular
 * dependencies. Nothing here performs cryptography; these are declarations only.
 */

/** SDK semantic version (kept in sync with package.json). */
export const SDK_VERSION = "1.0.0";

/**
 * Version tag embedded in serialized {@link EncryptedPayload} envelopes so that
 * a future breaking change to the wire format can be detected and migrated.
 */
export const PAYLOAD_FORMAT_VERSION = 1 as const;

/**
 * Authenticated symmetric encryption algorithms supported by the SDK.
 *
 * `AES-256-GCM` is the sole current option: an AEAD cipher that is FIPS-approved,
 * hardware-accelerated (AES-NI) on virtually all server CPUs, and provides
 * confidentiality + integrity in one pass.
 */
export enum SymmetricAlgorithm {
  AES_256_GCM = "AES-256-GCM",
}

/**
 * Asymmetric key algorithms supported by the SDK.
 *
 * - `X25519` — Elliptic-Curve Diffie–Hellman key agreement (produces shared secrets).
 * - `ED25519` — EdDSA digital signatures (sign / verify).
 *
 * The values match Node.js `KeyObject.asymmetricKeyType` strings exactly so they
 * can be cross-checked on import without translation.
 */
export enum AsymmetricAlgorithm {
  X25519 = "x25519",
  ED25519 = "ed25519",
}

/** Hash algorithms exposed by the hashing module. */
export enum HashAlgorithm {
  SHA256 = "sha256",
  SHA384 = "sha384",
  SHA512 = "sha512",
  /** BLAKE2b with 512-bit output (as provided by OpenSSL via Node's `createHash`). */
  BLAKE2B512 = "blake2b512",
}

/** Serialization formats for asymmetric keys. */
export enum KeyFormat {
  /** Raw 32-byte curve point / scalar (public keys, and private-key export only). */
  RAW = "raw",
  /** Binary ASN.1 DER (SPKI for public, PKCS#8 for private). */
  DER = "der",
  /** Base64 PEM text (SPKI for public, PKCS#8 for private). */
  PEM = "pem",
  /** JSON Web Key object (RFC 8037 OKP). */
  JWK = "jwk",
}

// ---------------------------------------------------------------------------
// Byte-length constants
// ---------------------------------------------------------------------------

/** AES-256 key length in bytes (256 bits). */
export const AES_256_GCM_KEY_BYTES = 32;

/**
 * Recommended GCM nonce/IV length in bytes (96 bits).
 *
 * 12 bytes is the value for which AES-GCM is defined without an extra GHASH
 * derivation step and is the universally recommended size (NIST SP 800-38D).
 */
export const GCM_NONCE_BYTES = 12;

/** AES-GCM authentication tag length in bytes (128 bits). */
export const GCM_TAG_BYTES = 16;

/** X25519 public/private key length in bytes. */
export const X25519_KEY_BYTES = 32;

/** Ed25519 public key length in bytes. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Ed25519 signature length in bytes. */
export const ED25519_SIGNATURE_BYTES = 64;

/**
 * Upper bound accepted by {@link randomBytes} (1 MiB). Guards against accidental
 * huge allocations from an unvalidated caller-supplied length.
 */
export const MAX_RANDOM_BYTES = 1_048_576;

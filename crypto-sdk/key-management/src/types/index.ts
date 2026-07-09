/**
 * @module types
 *
 * Central data-model types for the Key Management System (KMS). These are pure
 * declarations — no behaviour, no cryptography. Behavioural interfaces
 * (`KeyStorage`, `KeyCache`, `RotationPolicy`, …) live next to their modules and
 * are re-exported from the package root.
 *
 * NOTE: Nothing here references chat, users, sockets, JWT, or the database. The
 * `owner` field is an opaque string chosen by the caller; the KMS never
 * interprets it or ties it to authentication.
 */

import type {
  KeyPair,
  PublicKey,
  SymmetricKey,
  SharedSecret,
} from "@securechat/crypto-sdk";

/** The category of a managed key. Drives which repository owns it. */
export enum KeyType {
  /** Long-term identity signing key (Ed25519 key pair). */
  IDENTITY = "identity",
  /** Symmetric session/message key (AES-256). */
  SESSION = "session",
  /** Raw Diffie–Hellman shared secret. */
  SHARED_SECRET = "shared-secret",
  /** Ephemeral key-agreement prekey (X25519). Future protocol use. */
  PREKEY = "prekey",
  /** Signed prekey (X25519 + signature). Future protocol use. */
  SIGNED_PREKEY = "signed-prekey",
  /** One-time prekey (X25519). Future protocol use. */
  ONE_TIME_PREKEY = "one-time-prekey",
  /** Group/sender key (symmetric). Future protocol use. */
  GROUP = "group",
}

/** Lifecycle status of a key. Metadata only — the KMS never auto-transitions. */
export enum KeyStatus {
  /** Created but not yet activated. */
  PENDING = "pending",
  /** In active use. */
  ACTIVE = "active",
  /** Valid but not currently preferred (e.g. superseded, kept for decryption). */
  INACTIVE = "inactive",
  /** Superseded by a newer version via rotation. */
  ROTATED = "rotated",
  /** Past its `expiresAt`. */
  EXPIRED = "expired",
  /** Flagged as compromised; must not be used. */
  COMPROMISED = "compromised",
  /** Explicitly revoked. */
  REVOKED = "revoked",
  /** Soft-deleted marker (records are hard-deleted by storage). */
  DELETED = "deleted",
}

/** What a key is used for. Independent of algorithm. */
export enum KeyPurpose {
  SIGNING = "signing",
  KEY_AGREEMENT = "key-agreement",
  ENCRYPTION = "encryption",
  DERIVATION = "derivation",
  AUTHENTICATION = "authentication",
}

/** The shape of the underlying cryptographic material a managed key holds. */
export enum KeyMaterialKind {
  /** A single {@link SymmetricKey}. */
  SYMMETRIC = "symmetric",
  /** A {@link KeyPair} (public + private). */
  KEYPAIR = "keypair",
  /** A {@link PublicKey} only (no private material). */
  PUBLIC = "public",
  /** A {@link SharedSecret}. */
  SHARED_SECRET = "shared-secret",
  /** Opaque raw bytes. */
  RAW = "raw",
}

/**
 * Live cryptographic material, as a discriminated union of Sprint 1 SDK objects.
 * The KMS stores/serializes these but never inspects their secret bytes beyond
 * fingerprinting and (de)serialization.
 */
export type KeyMaterial =
  | { readonly kind: KeyMaterialKind.SYMMETRIC; readonly symmetricKey: SymmetricKey }
  | { readonly kind: KeyMaterialKind.KEYPAIR; readonly keyPair: KeyPair }
  | { readonly kind: KeyMaterialKind.PUBLIC; readonly publicKey: PublicKey }
  | { readonly kind: KeyMaterialKind.SHARED_SECRET; readonly sharedSecret: SharedSecret }
  | { readonly kind: KeyMaterialKind.RAW; readonly bytes: Uint8Array };

/**
 * Descriptive, JSON-safe metadata attached to every managed key. Future modules
 * should never need to invent their own metadata — extend via {@link KeyMetadata.custom}.
 */
export interface KeyMetadata {
  /** Unique, stable identifier for this key version. */
  keyId: string;
  /** Key category. */
  type: KeyType;
  /** Rotation version, starting at 1 and incremented on each rotation. */
  version: number;
  /** Algorithm identifier, e.g. `"ed25519"`, `"x25519"`, `"AES-256-GCM"`. */
  algorithm: string;
  /** Intended purpose. */
  purpose: KeyPurpose;
  /** Lifecycle status. */
  status: KeyStatus;
  /** Opaque owner identifier chosen by the caller (NOT tied to auth). */
  owner: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /** Optional ISO-8601 expiry timestamp (metadata only; not auto-enforced). */
  expiresAt?: string;
  /** Number of times this key lineage has been rotated. */
  rotationCount: number;
  /** `keyId` of the previous version in the rotation chain, if any. */
  previousKeyId?: string;
  /** Stable fingerprint (hex SHA-256 of the key's public/identifying material). */
  fingerprint: string;
  /** Optional human-readable label. */
  label?: string;
  /** Arbitrary caller-defined extension fields (must be JSON-serializable). */
  custom?: Record<string, unknown>;
  /** Version of the Crypto SDK that produced this key. */
  sdkVersion: string;
}

/** Serialized material form (all binary fields base64). See {@link SerializedKey}. */
export type SerializedMaterial =
  | { kind: "symmetric"; algorithm: string; key: string }
  | { kind: "keypair"; algorithm: string; publicKey: string; privateKey: string }
  | { kind: "public"; algorithm: string; publicKey: string }
  | { kind: "shared-secret"; secret: string }
  | { kind: "raw"; bytes: string };

/** Integrity descriptor embedded in a {@link SerializedKey}. */
export interface SerializedIntegrity {
  algorithm: "sha256";
  /** Hex digest over the canonical `{ metadata, material }` object. */
  value: string;
}

/**
 * Portable, versioned, integrity-checked serialized key. Safe to persist or
 * transmit (subject to the confidentiality of any private material within).
 */
export interface SerializedKey {
  /** Fixed format tag. */
  format: "securechat-kms-key";
  /** KMS serialization format version. */
  formatVersion: number;
  metadata: KeyMetadata;
  material: SerializedMaterial;
  integrity: SerializedIntegrity;
}

/**
 * A row in a {@link KeyStorage}. Index fields are stored in cleartext (for
 * querying); `payload` is the serialized {@link SerializedKey} JSON string and
 * may itself be encrypted at rest by `SecureStorage`.
 */
export interface StoredRecord {
  keyId: string;
  type: KeyType;
  owner: string;
  status: KeyStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Serialized key payload (plaintext JSON, or an encrypted envelope string). */
  payload: string;
  /** Whether `payload` is an encrypted envelope (true) or plaintext JSON (false). */
  encrypted: boolean;
}

/** Filter for querying storage/repositories. All fields are ANDed. */
export interface StorageFilter {
  owner?: string;
  type?: KeyType;
  status?: KeyStatus;
}

/** Injectable clock returning epoch milliseconds (for deterministic tests). */
export type Clock = () => number;

/** Injectable unique-id generator. */
export type IdGenerator = () => string;

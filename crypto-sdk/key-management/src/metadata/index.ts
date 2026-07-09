/**
 * @module metadata
 *
 * The metadata framework: creation, fingerprinting, timestamp helpers, and
 * expiry checks. Every managed key gets a complete {@link KeyMetadata} record so
 * future modules never invent their own.
 */

import { sha256, toHex, SDK_VERSION, randomId as sdkRandomId } from "@securechat/crypto-sdk";
import {
  KeyMaterialKind,
  KeyStatus,
  type Clock,
  type IdGenerator,
  type KeyMaterial,
  type KeyMetadata,
  type KeyPurpose,
  type KeyType,
} from "../types/index.js";

/** Default wall-clock (epoch ms). */
export const systemClock: Clock = () => Date.now();

/**
 * Default id generator: a `prefix_<128-bit>` id using the Crypto SDK's CSPRNG.
 * @example createIdGenerator("id")() // "id_Xa3f9Zt0Qb1cD2eF3gH4iA"
 */
export function createIdGenerator(prefix = "key"): IdGenerator {
  return () => `${prefix}_${sdkRandomId(16)}`;
}

/** Convert an epoch-ms / Date / ISO string into an ISO-8601 string. */
export function toIso(value: number | string | Date): string {
  if (typeof value === "string") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/**
 * Compute a stable fingerprint (hex SHA-256) of a key's identifying material.
 *
 * For asymmetric material the *public* bytes are hashed (safe to expose). For
 * symmetric/shared/raw secrets the digest is a one-way hash of the secret, which
 * does not reveal it but still uniquely identifies the key.
 */
export function computeFingerprint(material: KeyMaterial): string {
  let bytes: Uint8Array;
  switch (material.kind) {
    case KeyMaterialKind.SYMMETRIC:
      bytes = material.symmetricKey.bytes;
      break;
    case KeyMaterialKind.KEYPAIR:
      bytes = material.keyPair.publicKey.toRaw();
      break;
    case KeyMaterialKind.PUBLIC:
      bytes = material.publicKey.toRaw();
      break;
    case KeyMaterialKind.SHARED_SECRET:
      bytes = material.sharedSecret.bytes;
      break;
    case KeyMaterialKind.RAW:
      bytes = material.bytes;
      break;
  }
  return toHex(sha256(bytes));
}

/** Options for {@link createKeyMetadata}. */
export interface CreateMetadataOptions {
  type: KeyType;
  algorithm: string;
  purpose: KeyPurpose;
  owner: string;
  /** Fingerprint of the associated material (see {@link computeFingerprint}). */
  fingerprint: string;
  /** Explicit key id; generated if omitted. */
  keyId?: string;
  /** Initial status (default {@link KeyStatus.ACTIVE}). */
  status?: KeyStatus;
  /** Optional expiry (epoch ms / Date / ISO string). */
  expiresAt?: number | string | Date;
  label?: string;
  custom?: Record<string, unknown>;
  /** Version (default 1). */
  version?: number;
  /** Rotation count (default 0). */
  rotationCount?: number;
  /** Link to previous version. */
  previousKeyId?: string;
}

/** Injected environment for metadata creation. */
export interface MetadataContext {
  clock: Clock;
  idGenerator: IdGenerator;
  sdkVersion?: string;
}

/**
 * Build a complete {@link KeyMetadata} record, filling id, timestamps, version,
 * and SDK version.
 *
 * @example
 * ```ts
 * const meta = createKeyMetadata(
 *   { type: KeyType.IDENTITY, algorithm: "ed25519", purpose: KeyPurpose.SIGNING,
 *     owner: "user-123", fingerprint },
 *   { clock: systemClock, idGenerator: createIdGenerator("id") },
 * );
 * ```
 */
export function createKeyMetadata(
  options: CreateMetadataOptions,
  ctx: MetadataContext,
): KeyMetadata {
  const nowIso = toIso(ctx.clock());
  const metadata: KeyMetadata = {
    keyId: options.keyId ?? ctx.idGenerator(),
    type: options.type,
    version: options.version ?? 1,
    algorithm: options.algorithm,
    purpose: options.purpose,
    status: options.status ?? KeyStatus.ACTIVE,
    owner: options.owner,
    createdAt: nowIso,
    updatedAt: nowIso,
    rotationCount: options.rotationCount ?? 0,
    fingerprint: options.fingerprint,
    sdkVersion: ctx.sdkVersion ?? SDK_VERSION,
  };
  if (options.expiresAt !== undefined) metadata.expiresAt = toIso(options.expiresAt);
  if (options.label !== undefined) metadata.label = options.label;
  if (options.custom !== undefined) metadata.custom = { ...options.custom };
  if (options.previousKeyId !== undefined) metadata.previousKeyId = options.previousKeyId;
  return metadata;
}

/** Return a copy of `metadata` with `updatedAt` set to now. */
export function touchMetadata(metadata: KeyMetadata, clock: Clock = systemClock): KeyMetadata {
  return { ...metadata, updatedAt: toIso(clock()) };
}

/**
 * Whether `metadata` is past its `expiresAt`. Keys without an expiry never expire.
 * @param now epoch ms to compare against (default: system clock).
 */
export function isExpired(metadata: KeyMetadata, now: number = Date.now()): boolean {
  if (!metadata.expiresAt) return false;
  const expiry = Date.parse(metadata.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return now >= expiry;
}

/** Milliseconds until expiry (negative if already expired, `Infinity` if none). */
export function timeToExpiry(metadata: KeyMetadata, now: number = Date.now()): number {
  if (!metadata.expiresAt) return Infinity;
  const expiry = Date.parse(metadata.expiresAt);
  if (Number.isNaN(expiry)) return Infinity;
  return expiry - now;
}

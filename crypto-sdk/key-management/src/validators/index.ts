/**
 * @module validators
 *
 * Validation of managed keys and their metadata: format, required fields, enum
 * membership, material lengths, fingerprint consistency, and expiry. All failures
 * raise {@link KeyValidationError} (or {@link KeyExpiredError} for expiry) with a
 * `details` object naming the offending field.
 */

import {
  AsymmetricAlgorithm,
  SymmetricAlgorithm,
  constantTimeEqual,
  utf8ToBytes,
  ED25519_SIGNATURE_BYTES,
} from "@securechat/crypto-sdk";
import {
  KeyMaterialKind,
  KeyPurpose,
  KeyStatus,
  KeyType,
  type KeyMaterial,
  type KeyMetadata,
} from "../types/index.js";
import { ManagedKey } from "../managed-key.js";
import { KeyExpiredError, KeyValidationError } from "../errors/index.js";
import { computeFingerprint, isExpired } from "../metadata/index.js";

const KEY_TYPES = new Set<string>(Object.values(KeyType));
const KEY_STATUSES = new Set<string>(Object.values(KeyStatus));
const KEY_PURPOSES = new Set<string>(Object.values(KeyPurpose));

function fail(message: string, field: string, keyId?: string): never {
  throw new KeyValidationError(message, { details: { field, keyId } });
}

/** Options controlling {@link KeyValidator.validateManagedKey}. */
export interface ValidateOptions {
  /** Also verify the material's fingerprint matches the metadata (default true). */
  checkFingerprint?: boolean;
  /** Also reject expired keys (default false). */
  checkExpiry?: boolean;
  /** Epoch ms used for expiry checks (default: now). */
  now?: number;
}

/**
 * Stateless validator. Construct once and reuse.
 *
 * @example
 * ```ts
 * const validator = new KeyValidator();
 * validator.validateManagedKey(managedKey, { checkExpiry: true });
 * ```
 */
export class KeyValidator {
  /**
   * Validate a metadata record's structure and field values.
   * @throws {KeyValidationError}
   */
  validateMetadata(metadata: KeyMetadata): void {
    if (!metadata || typeof metadata !== "object") fail("metadata must be an object", "metadata");
    const m = metadata;
    if (typeof m.keyId !== "string" || m.keyId.length === 0) fail("keyId is required", "keyId");
    if (!KEY_TYPES.has(m.type)) fail(`invalid type: ${m.type}`, "type", m.keyId);
    if (!KEY_STATUSES.has(m.status)) fail(`invalid status: ${m.status}`, "status", m.keyId);
    if (!KEY_PURPOSES.has(m.purpose)) fail(`invalid purpose: ${m.purpose}`, "purpose", m.keyId);
    if (typeof m.algorithm !== "string" || m.algorithm.length === 0)
      fail("algorithm is required", "algorithm", m.keyId);
    if (typeof m.owner !== "string") fail("owner is required", "owner", m.keyId);
    if (!Number.isInteger(m.version) || m.version < 1) fail("version must be an integer >= 1", "version", m.keyId);
    if (!Number.isInteger(m.rotationCount) || m.rotationCount < 0)
      fail("rotationCount must be a non-negative integer", "rotationCount", m.keyId);
    if (typeof m.fingerprint !== "string" || m.fingerprint.length === 0)
      fail("fingerprint is required", "fingerprint", m.keyId);
    if (typeof m.sdkVersion !== "string" || m.sdkVersion.length === 0)
      fail("sdkVersion is required", "sdkVersion", m.keyId);
    this.assertIsoDate(m.createdAt, "createdAt", m.keyId);
    this.assertIsoDate(m.updatedAt, "updatedAt", m.keyId);
    if (m.expiresAt !== undefined) this.assertIsoDate(m.expiresAt, "expiresAt", m.keyId);
  }

  /**
   * Validate material lengths against the declared algorithm.
   * @throws {KeyValidationError}
   */
  validateMaterial(material: KeyMaterial, keyId?: string): void {
    switch (material.kind) {
      case KeyMaterialKind.SYMMETRIC:
        if (material.symmetricKey.algorithm !== SymmetricAlgorithm.AES_256_GCM)
          fail("unsupported symmetric algorithm", "material", keyId);
        if (material.symmetricKey.length !== 32) fail("symmetric key must be 32 bytes", "material", keyId);
        break;
      case KeyMaterialKind.KEYPAIR:
        this.assertCurveKeyLength(material.keyPair.algorithm, material.keyPair.publicKey.toRaw(), keyId);
        break;
      case KeyMaterialKind.PUBLIC:
        this.assertCurveKeyLength(material.publicKey.algorithm, material.publicKey.toRaw(), keyId);
        break;
      case KeyMaterialKind.SHARED_SECRET:
        if (material.sharedSecret.length === 0) fail("shared secret must not be empty", "material", keyId);
        break;
      case KeyMaterialKind.RAW:
        if (material.bytes.length === 0) fail("raw material must not be empty", "material", keyId);
        break;
    }
  }

  /**
   * Verify the material's recomputed fingerprint matches the metadata fingerprint
   * (detects corruption / mismatched pairing). Constant-time comparison.
   * @throws {KeyValidationError}
   */
  validateFingerprint(key: ManagedKey): void {
    const actual = computeFingerprint(key.material);
    if (!constantTimeEqual(utf8ToBytes(actual), utf8ToBytes(key.metadata.fingerprint))) {
      fail("fingerprint does not match key material", "fingerprint", key.keyId);
    }
  }

  /**
   * Reject an expired key.
   * @throws {KeyExpiredError}
   */
  validateNotExpired(metadata: KeyMetadata, now: number = Date.now()): void {
    if (isExpired(metadata, now)) {
      throw new KeyExpiredError(`Key ${metadata.keyId} expired at ${metadata.expiresAt}`, {
        details: { keyId: metadata.keyId, expiresAt: metadata.expiresAt },
      });
    }
  }

  /**
   * Full validation of a managed key: metadata + material (+ optional fingerprint
   * and expiry checks).
   * @throws {KeyValidationError | KeyExpiredError}
   */
  validateManagedKey(key: ManagedKey, options: ValidateOptions = {}): void {
    if (!(key instanceof ManagedKey)) fail("value must be a ManagedKey", "key");
    this.validateMetadata(key.metadata);
    this.validateMaterial(key.material, key.keyId);
    if (options.checkFingerprint !== false) this.validateFingerprint(key);
    if (options.checkExpiry) this.validateNotExpired(key.metadata, options.now ?? Date.now());
  }

  // --- helpers -------------------------------------------------------------

  private assertIsoDate(value: string, field: string, keyId?: string): void {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      fail(`${field} must be an ISO-8601 date string`, field, keyId);
    }
  }

  private assertCurveKeyLength(algorithm: string, publicRaw: Uint8Array, keyId?: string): void {
    if (algorithm === AsymmetricAlgorithm.ED25519 || algorithm === AsymmetricAlgorithm.X25519) {
      if (publicRaw.length !== 32) fail(`${algorithm} public key must be 32 bytes`, "material", keyId);
      return;
    }
    fail(`unsupported asymmetric algorithm: ${algorithm}`, "material", keyId);
  }
}

/** Exposed for tests / callers: the Ed25519 signature length constant. */
export { ED25519_SIGNATURE_BYTES };

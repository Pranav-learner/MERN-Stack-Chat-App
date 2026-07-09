/**
 * @module serializers
 *
 * Secure, versioned, integrity-checked (de)serialization of {@link ManagedKey}
 * objects to/from portable forms: a structured {@link SerializedKey}, a JSON
 * string, base64, or raw binary.
 *
 * Integrity: a SHA-256 digest is computed over the canonical `{ metadata,
 * material }` object and embedded. On deserialization it is recomputed and
 * compared in constant time — any tampering or corruption raises
 * {@link SerializationError}.
 *
 * Private material for key pairs is encoded as PKCS#8 DER (the Crypto SDK does
 * not support raw private-key import); public material as raw 32-byte points.
 */

import {
  AsymmetricAlgorithm,
  KeyPair,
  PrivateKey,
  PublicKey,
  SharedSecret,
  SymmetricKey,
  constantTimeEqual,
  fromBase64,
  sha256,
  toBase64,
  toHex,
  utf8ToBytes,
  bytesToUtf8,
} from "@securechat/crypto-sdk";
import {
  KeyMaterialKind,
  type KeyMaterial,
  type SerializedKey,
  type SerializedMaterial,
} from "../types/index.js";
import { ManagedKey } from "../managed-key.js";
import { SerializationError, UnsupportedVersionError } from "../errors/index.js";
import type { MigrationRegistry } from "../migration/index.js";

/** Current KMS serialization format version. */
export const CURRENT_FORMAT_VERSION = 1;

const FORMAT_TAG = "securechat-kms-key" as const;

/** Deterministic JSON: recursively sort object keys so digests are stable. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Map an algorithm string to the SDK's {@link AsymmetricAlgorithm}. */
function toAsymmetricAlgorithm(algorithm: string): AsymmetricAlgorithm {
  if (algorithm === AsymmetricAlgorithm.ED25519) return AsymmetricAlgorithm.ED25519;
  if (algorithm === AsymmetricAlgorithm.X25519) return AsymmetricAlgorithm.X25519;
  throw new SerializationError(`Unsupported asymmetric algorithm: ${algorithm}`);
}

/**
 * (De)serializer for managed keys. Stateless apart from an optional
 * {@link MigrationRegistry} used to upgrade older serialized formats.
 */
export class KeySerializer {
  constructor(private readonly migrations?: MigrationRegistry) {}

  // --- structured form -----------------------------------------------------

  /**
   * Serialize a {@link ManagedKey} to a {@link SerializedKey} object.
   * @throws {SerializationError} if the material cannot be encoded.
   */
  serialize(key: ManagedKey): SerializedKey {
    const material = this.serializeMaterial(key.material);
    const body = { metadata: key.metadata, material };
    const integrity = { algorithm: "sha256" as const, value: this.digest(body) };
    return { format: FORMAT_TAG, formatVersion: CURRENT_FORMAT_VERSION, ...body, integrity };
  }

  /**
   * Reconstruct a {@link ManagedKey} from a {@link SerializedKey}, verifying the
   * format tag, version, and integrity digest.
   * @throws {UnsupportedVersionError} on an unknown, unmigratable version.
   * @throws {SerializationError} on a bad tag or failed integrity check.
   */
  deserialize(input: SerializedKey): ManagedKey {
    let serialized = input;
    if (serialized?.format !== FORMAT_TAG) {
      throw new SerializationError("Unrecognized serialized key format tag");
    }
    if (serialized.formatVersion !== CURRENT_FORMAT_VERSION) {
      serialized = this.tryMigrate(serialized);
    }
    // Verify integrity over the canonical body.
    const expected = this.digest({ metadata: serialized.metadata, material: serialized.material });
    const actual = serialized.integrity?.value ?? "";
    if (!constantTimeEqual(utf8ToBytes(expected), utf8ToBytes(actual))) {
      throw new SerializationError("Integrity check failed: serialized key is corrupted or tampered", {
        details: { keyId: serialized.metadata?.keyId },
      });
    }
    const material = this.deserializeMaterial(serialized.material);
    return new ManagedKey({ metadata: serialized.metadata, material });
  }

  // --- string / base64 / binary forms -------------------------------------

  /** Serialize to a compact JSON string. */
  toJSON(key: ManagedKey): string {
    return JSON.stringify(this.serialize(key));
  }

  /** Parse a JSON string produced by {@link toJSON}. @throws {SerializationError} */
  fromJSON(json: string): ManagedKey {
    let obj: SerializedKey;
    try {
      obj = JSON.parse(json) as SerializedKey;
    } catch (cause) {
      throw new SerializationError("Serialized key is not valid JSON", { cause });
    }
    return this.deserialize(obj);
  }

  /** Serialize to base64 (of the UTF-8 JSON). */
  toBase64(key: ManagedKey): string {
    return toBase64(utf8ToBytes(this.toJSON(key)));
  }

  /** Parse a base64 form produced by {@link toBase64}. */
  fromBase64(b64: string): ManagedKey {
    return this.fromJSON(bytesToUtf8(fromBase64(b64)));
  }

  /** Serialize to raw binary (UTF-8 JSON bytes). */
  toBinary(key: ManagedKey): Uint8Array {
    return utf8ToBytes(this.toJSON(key));
  }

  /** Parse a binary form produced by {@link toBinary}. */
  fromBinary(bytes: Uint8Array): ManagedKey {
    return this.fromJSON(bytesToUtf8(bytes));
  }

  // --- internals -----------------------------------------------------------

  private digest(body: { metadata: unknown; material: unknown }): string {
    return toHex(sha256(stableStringify(body)));
  }

  private tryMigrate(serialized: SerializedKey): SerializedKey {
    if (this.migrations) {
      const migrated = this.migrations.migrate(serialized, CURRENT_FORMAT_VERSION);
      if (migrated) return migrated;
    }
    throw new UnsupportedVersionError(
      `Unsupported serialized key version ${serialized.formatVersion} (expected ${CURRENT_FORMAT_VERSION})`,
      { details: { version: serialized.formatVersion } },
    );
  }

  private serializeMaterial(material: KeyMaterial): SerializedMaterial {
    switch (material.kind) {
      case KeyMaterialKind.SYMMETRIC:
        return {
          kind: "symmetric",
          algorithm: material.symmetricKey.algorithm,
          key: material.symmetricKey.toBase64(),
        };
      case KeyMaterialKind.KEYPAIR:
        return {
          kind: "keypair",
          algorithm: material.keyPair.algorithm,
          publicKey: toBase64(material.keyPair.publicKey.toRaw()),
          privateKey: toBase64(material.keyPair.privateKey.toDER()),
        };
      case KeyMaterialKind.PUBLIC:
        return {
          kind: "public",
          algorithm: material.publicKey.algorithm,
          publicKey: toBase64(material.publicKey.toRaw()),
        };
      case KeyMaterialKind.SHARED_SECRET:
        return { kind: "shared-secret", secret: toBase64(material.sharedSecret.bytes) };
      case KeyMaterialKind.RAW:
        return { kind: "raw", bytes: toBase64(material.bytes) };
    }
  }

  private deserializeMaterial(material: SerializedMaterial): KeyMaterial {
    try {
      switch (material.kind) {
        case "symmetric":
          return {
            kind: KeyMaterialKind.SYMMETRIC,
            symmetricKey: SymmetricKey.fromBase64(material.key),
          };
        case "keypair": {
          const alg = toAsymmetricAlgorithm(material.algorithm);
          const publicKey = PublicKey.fromRaw(fromBase64(material.publicKey), alg);
          const privateKey = PrivateKey.fromDER(fromBase64(material.privateKey), alg);
          return { kind: KeyMaterialKind.KEYPAIR, keyPair: new KeyPair(publicKey, privateKey) };
        }
        case "public": {
          const alg = toAsymmetricAlgorithm(material.algorithm);
          return { kind: KeyMaterialKind.PUBLIC, publicKey: PublicKey.fromRaw(fromBase64(material.publicKey), alg) };
        }
        case "shared-secret":
          return {
            kind: KeyMaterialKind.SHARED_SECRET,
            sharedSecret: SharedSecret.fromBytes(fromBase64(material.secret)),
          };
        case "raw":
          return { kind: KeyMaterialKind.RAW, bytes: fromBase64(material.bytes) };
        default:
          throw new SerializationError(
            `Unknown material kind: ${(material as { kind?: string }).kind}`,
          );
      }
    } catch (cause) {
      if (cause instanceof SerializationError) throw cause;
      throw new SerializationError("Failed to reconstruct key material", { cause });
    }
  }
}

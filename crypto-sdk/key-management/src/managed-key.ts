/**
 * @module managed-key
 *
 * {@link ManagedKey} — the central value object of the KMS: immutable metadata
 * plus live cryptographic material (a Sprint 1 SDK object). It is transport- and
 * storage-agnostic and knows nothing about chat.
 */

import type {
  KeyPair,
  PublicKey,
  SymmetricKey,
  SharedSecret,
} from "@securechat/crypto-sdk";
import { KeyMaterialKind, type KeyMaterial, type KeyMetadata } from "./types/index.js";
import { KeyValidationError } from "./errors/index.js";

/** Construction input for {@link ManagedKey}. */
export interface ManagedKeyInit {
  metadata: KeyMetadata;
  material: KeyMaterial;
}

/**
 * A key under management: `{ metadata, material }`.
 *
 * Instances are treated as immutable — metadata is copied on construction and
 * lifecycle changes produce a new instance via {@link ManagedKey.withMetadata}.
 *
 * @example
 * ```ts
 * const mk = ManagedKey.fromSymmetricKey(SymmetricKey.generate(), metadata);
 * const key = mk.asSymmetricKey();               // typed accessor
 * const rotated = mk.withMetadata({ status: KeyStatus.ROTATED });
 * ```
 */
export class ManagedKey {
  /** Immutable metadata snapshot. */
  public readonly metadata: KeyMetadata;
  private readonly _material: KeyMaterial;

  constructor(init: ManagedKeyInit) {
    // Shallow-copy metadata (and custom) so external mutation can't leak in.
    this.metadata = {
      ...init.metadata,
      ...(init.metadata.custom ? { custom: { ...init.metadata.custom } } : {}),
    };
    this._material = init.material;
  }

  /** The live key material union. */
  get material(): KeyMaterial {
    return this._material;
  }

  /** Convenience: the key id. */
  get keyId(): string {
    return this.metadata.keyId;
  }

  /** Convenience: the key type. */
  get materialKind(): KeyMaterialKind {
    return this._material.kind;
  }

  // --- factories -----------------------------------------------------------

  /** Wrap a {@link SymmetricKey}. */
  static fromSymmetricKey(key: SymmetricKey, metadata: KeyMetadata): ManagedKey {
    return new ManagedKey({
      metadata,
      material: { kind: KeyMaterialKind.SYMMETRIC, symmetricKey: key },
    });
  }

  /** Wrap a {@link KeyPair}. */
  static fromKeyPair(keyPair: KeyPair, metadata: KeyMetadata): ManagedKey {
    return new ManagedKey({ metadata, material: { kind: KeyMaterialKind.KEYPAIR, keyPair } });
  }

  /** Wrap a {@link PublicKey} (no private material). */
  static fromPublicKey(publicKey: PublicKey, metadata: KeyMetadata): ManagedKey {
    return new ManagedKey({ metadata, material: { kind: KeyMaterialKind.PUBLIC, publicKey } });
  }

  /** Wrap a {@link SharedSecret}. */
  static fromSharedSecret(sharedSecret: SharedSecret, metadata: KeyMetadata): ManagedKey {
    return new ManagedKey({
      metadata,
      material: { kind: KeyMaterialKind.SHARED_SECRET, sharedSecret },
    });
  }

  /** Wrap opaque raw bytes. */
  static fromRawBytes(bytes: Uint8Array, metadata: KeyMetadata): ManagedKey {
    return new ManagedKey({ metadata, material: { kind: KeyMaterialKind.RAW, bytes } });
  }

  // --- typed accessors -----------------------------------------------------

  /** @throws {KeyValidationError} if this key does not hold a symmetric key. */
  asSymmetricKey(): SymmetricKey {
    if (this._material.kind !== KeyMaterialKind.SYMMETRIC) {
      throw this.wrongKind(KeyMaterialKind.SYMMETRIC);
    }
    return this._material.symmetricKey;
  }

  /** @throws {KeyValidationError} if this key does not hold a key pair. */
  asKeyPair(): KeyPair {
    if (this._material.kind !== KeyMaterialKind.KEYPAIR) {
      throw this.wrongKind(KeyMaterialKind.KEYPAIR);
    }
    return this._material.keyPair;
  }

  /**
   * Return a {@link PublicKey} — from a public-only key, or the public half of a
   * key pair.
   * @throws {KeyValidationError} if no public material is present.
   */
  asPublicKey(): PublicKey {
    if (this._material.kind === KeyMaterialKind.PUBLIC) return this._material.publicKey;
    if (this._material.kind === KeyMaterialKind.KEYPAIR) return this._material.keyPair.publicKey;
    throw this.wrongKind(KeyMaterialKind.PUBLIC);
  }

  /** @throws {KeyValidationError} if this key does not hold a shared secret. */
  asSharedSecret(): SharedSecret {
    if (this._material.kind !== KeyMaterialKind.SHARED_SECRET) {
      throw this.wrongKind(KeyMaterialKind.SHARED_SECRET);
    }
    return this._material.sharedSecret;
  }

  /** @throws {KeyValidationError} if this key does not hold raw bytes. */
  asRawBytes(): Uint8Array {
    if (this._material.kind !== KeyMaterialKind.RAW) {
      throw this.wrongKind(KeyMaterialKind.RAW);
    }
    return this._material.bytes;
  }

  /** Whether this key holds any private/secret material. */
  hasPrivateMaterial(): boolean {
    return this._material.kind !== KeyMaterialKind.PUBLIC;
  }

  // --- immutable updates ---------------------------------------------------

  /**
   * Produce a new {@link ManagedKey} with `patch` merged into metadata. The
   * material reference is shared (not copied). Used for lifecycle transitions.
   */
  withMetadata(patch: Partial<KeyMetadata>): ManagedKey {
    return new ManagedKey({
      metadata: { ...this.metadata, ...patch },
      material: this._material,
    });
  }

  /**
   * Produce a public-only view of this key (strips private material). For a key
   * pair this yields its public key; for a public-only key it returns itself.
   * @throws {ExportError-like KeyValidationError} if there is no public material.
   */
  toPublicOnly(): ManagedKey {
    if (this._material.kind === KeyMaterialKind.PUBLIC) return this;
    if (this._material.kind === KeyMaterialKind.KEYPAIR) {
      return new ManagedKey({
        metadata: this.metadata,
        material: { kind: KeyMaterialKind.PUBLIC, publicKey: this._material.keyPair.publicKey },
      });
    }
    throw new KeyValidationError("Key has no public material to export", {
      details: { keyId: this.keyId, kind: this._material.kind },
    });
  }

  /** Avoid leaking secret material via logs / JSON.stringify. */
  toJSON(): { keyId: string; type: string; kind: KeyMaterialKind } {
    return { keyId: this.keyId, type: this.metadata.type, kind: this._material.kind };
  }

  private wrongKind(expected: KeyMaterialKind): KeyValidationError {
    return new KeyValidationError(
      `Expected ${expected} material but key ${this.keyId} holds ${this._material.kind}`,
      { details: { keyId: this.keyId, expected, actual: this._material.kind } },
    );
  }
}

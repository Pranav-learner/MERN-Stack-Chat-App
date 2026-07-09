/**
 * @module manager
 *
 * {@link KeyManager} — the primary entry point of the KMS. It composes storage,
 * cache, serializer, validator, repositories, rotation, and recovery into one
 * cohesive lifecycle API: generate, store, retrieve, import, export, replace,
 * rotate, delete, validate, expire, recover.
 *
 * It builds ONLY on the Sprint 1 Crypto SDK for cryptography and never touches
 * chat, transport, auth, or the database.
 */

import {
  KeyPair,
  SharedSecret,
  generateKey,
  generateKeyPair,
  generateSigningKeyPair,
} from "@securechat/crypto-sdk";
import {
  KeyMaterialKind,
  KeyPurpose,
  KeyStatus,
  KeyType,
  type Clock,
  type IdGenerator,
  type KeyMaterial,
  type SerializedKey,
  type StorageFilter,
} from "../types/index.js";
import { ManagedKey } from "../managed-key.js";
import {
  computeFingerprint,
  createIdGenerator,
  createKeyMetadata,
  systemClock,
  toIso,
  type MetadataContext,
} from "../metadata/index.js";
import { KeySerializer } from "../serializers/index.js";
import { KeyValidator, type ValidateOptions } from "../validators/index.js";
import { MemoryStorage, type KeyStorage } from "../storage/index.js";
import { InMemoryKeyCache, type KeyCache } from "../cache/index.js";
import {
  BaseKeyRepository,
  GroupKeyRepository,
  IdentityKeyRepository,
  OneTimeKeyRepository,
  PreKeyRepository,
  SessionKeyRepository,
  SharedSecretRepository,
  SignedPreKeyRepository,
  type RepositoryContext,
} from "../repository/index.js";
import {
  RotationScheduler,
  buildHistoryChain,
  type KeyHistoryEntry,
  type RotationContext,
  type RotationDecision,
  type RotationPolicy,
} from "../rotation/index.js";
import { NoopRecoveryProvider, type RecoveryProvider } from "../recovery/index.js";
import { MigrationRegistry } from "../migration/index.js";
import { ExportError, ImportError, KeyNotFoundError, RotationError } from "../errors/index.js";

/** Options for constructing a {@link KeyManager}. */
export interface KeyManagerOptions {
  /** Storage backend (default {@link MemoryStorage}). */
  storage?: KeyStorage;
  /** Cache implementation (default {@link InMemoryKeyCache}). */
  cache?: KeyCache;
  /** Injectable clock (default system clock). */
  clock?: Clock;
  /** Injectable id generator (default `key_<random>`). */
  idGenerator?: IdGenerator;
  /** Recovery provider (default {@link NoopRecoveryProvider}). */
  recoveryProvider?: RecoveryProvider;
  /** Serialization migration registry (default empty). */
  migrationRegistry?: MigrationRegistry;
}

/** Common options for the `generate*` / `store*` helpers. */
export interface GenerateKeyOptions {
  /** Opaque owner identifier (not tied to auth). */
  owner: string;
  label?: string;
  expiresAt?: number | string | Date;
  custom?: Record<string, unknown>;
  /** Force a specific key id (else generated). */
  keyId?: string;
  /** Initial status (default {@link KeyStatus.ACTIVE}). */
  status?: KeyStatus;
}

/** Options for {@link KeyManager.exportKey}. */
export interface ExportKeyOptions {
  /** Include private material (default false → public-only export). */
  includePrivate?: boolean;
  /** Output encoding (default `"json"`). */
  encoding?: "json" | "base64" | "binary" | "object";
}

/** Options for {@link KeyManager.importKey}. */
export interface ImportKeyOptions {
  /** Replace an existing key with the same id instead of throwing (default false). */
  overwrite?: boolean;
}

/** A material generator used during rotation. */
export type MaterialGenerator = (previous: ManagedKey) => KeyMaterial | Promise<KeyMaterial>;

/** Result of a rotation: the retired previous version and the new current one. */
export interface RotationResult {
  previous: ManagedKey;
  current: ManagedKey;
}

/**
 * The Key Management System facade.
 *
 * @example
 * ```ts
 * const km = new KeyManager();
 * const id = await km.generateIdentityKey({ owner: "user-1" });
 * const exported = await km.exportKey(id.keyId);          // public-only JSON
 * const fetched = await km.getKey(id.keyId);
 * const { current } = await km.rotateKey(id.keyId);       // new Ed25519 version
 * ```
 */
export class KeyManager {
  private readonly ctx: RepositoryContext;
  private readonly metaCtx: MetadataContext;
  private readonly scheduler = new RotationScheduler();
  private readonly recoveryProvider: RecoveryProvider;
  private readonly repos: Record<KeyType, BaseKeyRepository>;

  /** Typed repositories over the shared storage/cache. */
  public readonly identityKeys: IdentityKeyRepository;
  public readonly sessionKeys: SessionKeyRepository;
  public readonly sharedSecrets: SharedSecretRepository;
  public readonly preKeys: PreKeyRepository;
  public readonly signedPreKeys: SignedPreKeyRepository;
  public readonly oneTimeKeys: OneTimeKeyRepository;
  public readonly groupKeys: GroupKeyRepository;

  constructor(options: KeyManagerOptions = {}) {
    const clock = options.clock ?? systemClock;
    this.ctx = {
      storage: options.storage ?? new MemoryStorage(),
      cache: options.cache ?? new InMemoryKeyCache(),
      serializer: new KeySerializer(options.migrationRegistry ?? new MigrationRegistry()),
      validator: new KeyValidator(),
      clock,
    };
    this.metaCtx = { clock, idGenerator: options.idGenerator ?? createIdGenerator("key") };
    this.recoveryProvider = options.recoveryProvider ?? new NoopRecoveryProvider();

    this.identityKeys = new IdentityKeyRepository(this.ctx);
    this.sessionKeys = new SessionKeyRepository(this.ctx);
    this.sharedSecrets = new SharedSecretRepository(this.ctx);
    this.preKeys = new PreKeyRepository(this.ctx);
    this.signedPreKeys = new SignedPreKeyRepository(this.ctx);
    this.oneTimeKeys = new OneTimeKeyRepository(this.ctx);
    this.groupKeys = new GroupKeyRepository(this.ctx);
    this.repos = {
      [KeyType.IDENTITY]: this.identityKeys,
      [KeyType.SESSION]: this.sessionKeys,
      [KeyType.SHARED_SECRET]: this.sharedSecrets,
      [KeyType.PREKEY]: this.preKeys,
      [KeyType.SIGNED_PREKEY]: this.signedPreKeys,
      [KeyType.ONE_TIME_PREKEY]: this.oneTimeKeys,
      [KeyType.GROUP]: this.groupKeys,
    };
  }

  /** Access the underlying cache (e.g. for stats). */
  get cache(): KeyCache {
    return this.ctx.cache;
  }

  // === generation ==========================================================

  /** Generate and store a long-term identity key (Ed25519 key pair). */
  generateIdentityKey(options: GenerateKeyOptions): Promise<ManagedKey> {
    const keyPair = generateSigningKeyPair();
    return this.storeKey(
      this.build(
        KeyType.IDENTITY,
        { kind: KeyMaterialKind.KEYPAIR, keyPair },
        keyPair.algorithm,
        KeyPurpose.SIGNING,
        options,
      ),
    );
  }

  /** Generate and store a symmetric session key (AES-256). */
  generateSessionKey(options: GenerateKeyOptions): Promise<ManagedKey> {
    const symmetricKey = generateKey();
    return this.storeKey(
      this.build(
        KeyType.SESSION,
        { kind: KeyMaterialKind.SYMMETRIC, symmetricKey },
        symmetricKey.algorithm,
        KeyPurpose.ENCRYPTION,
        options,
      ),
    );
  }

  /**
   * Generate and store an X25519 key-agreement key. Defaults to a plain prekey;
   * pass `type` for signed / one-time prekeys.
   */
  generateAgreementKey(
    options: GenerateKeyOptions,
    type: KeyType.PREKEY | KeyType.SIGNED_PREKEY | KeyType.ONE_TIME_PREKEY = KeyType.PREKEY,
  ): Promise<ManagedKey> {
    const keyPair = generateKeyPair(); // X25519
    return this.storeKey(
      this.build(
        type,
        { kind: KeyMaterialKind.KEYPAIR, keyPair },
        keyPair.algorithm,
        KeyPurpose.KEY_AGREEMENT,
        options,
      ),
    );
  }

  /** Store an externally-derived {@link SharedSecret}. */
  storeSharedSecret(secret: SharedSecret, options: GenerateKeyOptions): Promise<ManagedKey> {
    return this.storeKey(
      this.build(
        KeyType.SHARED_SECRET,
        { kind: KeyMaterialKind.SHARED_SECRET, sharedSecret: secret },
        "shared-secret",
        KeyPurpose.DERIVATION,
        options,
      ),
    );
  }

  /** Store opaque raw key bytes with an explicit algorithm/purpose/type. */
  storeRawKey(
    bytes: Uint8Array,
    options: GenerateKeyOptions & { algorithm: string; purpose: KeyPurpose; type?: KeyType },
  ): Promise<ManagedKey> {
    return this.storeKey(
      this.build(
        options.type ?? KeyType.GROUP,
        { kind: KeyMaterialKind.RAW, bytes },
        options.algorithm,
        options.purpose,
        options,
      ),
    );
  }

  // === generic lifecycle ===================================================

  /** Validate and persist a managed key (routes to its typed repository). */
  storeKey(key: ManagedKey): Promise<ManagedKey> {
    return this.repoFor(key.metadata.type).save(key);
  }

  /** Retrieve a key by id. @throws {KeyNotFoundError} */
  async getKey(keyId: string): Promise<ManagedKey> {
    const key = await this.findKey(keyId);
    if (!key) throw new KeyNotFoundError(`Key ${keyId} not found`, { details: { keyId } });
    return key;
  }

  /** Retrieve a key by id, or `null` if absent (cache → storage). */
  async findKey(keyId: string): Promise<ManagedKey | null> {
    const cached = this.ctx.cache.get(keyId);
    if (cached) return cached;
    const record = await this.ctx.storage.get(keyId);
    if (!record) return null;
    const key = this.ctx.serializer.fromJSON(record.payload);
    this.ctx.cache.set(keyId, key);
    return key;
  }

  /** Whether a key exists. */
  async hasKey(keyId: string): Promise<boolean> {
    return this.ctx.cache.has(keyId) || this.ctx.storage.has(keyId);
  }

  /** Validate and replace an existing key (routes to its typed repository). */
  replaceKey(key: ManagedKey): Promise<ManagedKey> {
    return this.repoFor(key.metadata.type).replace(key);
  }

  /** Delete a key from storage and cache. */
  async deleteKey(keyId: string): Promise<boolean> {
    this.ctx.cache.invalidate(keyId);
    return this.ctx.storage.delete(keyId);
  }

  /** List keys matching an optional filter (across all types). */
  async listKeys(filter?: StorageFilter): Promise<ManagedKey[]> {
    const records = await this.ctx.storage.list(filter);
    return records.map((r) => this.ctx.serializer.fromJSON(r.payload));
  }

  /** Count keys matching an optional filter. */
  countKeys(filter?: StorageFilter): Promise<number> {
    return this.ctx.storage.count(filter);
  }

  /**
   * Validate a stored key (metadata + material + fingerprint, and expiry by
   * default). @throws {KeyValidationError | KeyExpiredError | KeyNotFoundError}
   */
  async validateKey(keyId: string, options: ValidateOptions = {}): Promise<void> {
    const key = await this.getKey(keyId);
    this.ctx.validator.validateManagedKey(key, { checkExpiry: true, ...options });
  }

  // === status transitions (metadata only) =================================

  /** Set a key's status to {@link KeyStatus.EXPIRED} (metadata only). */
  expireKey(keyId: string): Promise<ManagedKey> {
    return this.setStatus(keyId, KeyStatus.EXPIRED);
  }

  /** Set a key's lifecycle status (metadata only). */
  async setStatus(keyId: string, status: KeyStatus): Promise<ManagedKey> {
    const key = await this.getKey(keyId);
    const updated = key.withMetadata({ status, updatedAt: toIso(this.ctx.clock()) });
    return this.replaceKey(updated);
  }

  // === import / export =====================================================

  /**
   * Import a key from a serialized form (JSON string, base64 string, binary, or a
   * {@link SerializedKey} object). @throws {ImportError | DuplicateKeyError}
   */
  async importKey(
    input: string | Uint8Array | SerializedKey,
    options: ImportKeyOptions = {},
  ): Promise<ManagedKey> {
    let key: ManagedKey;
    try {
      if (typeof input === "string") {
        key = input.trimStart().startsWith("{")
          ? this.ctx.serializer.fromJSON(input)
          : this.ctx.serializer.fromBase64(input);
      } else if (input instanceof Uint8Array) {
        key = this.ctx.serializer.fromBinary(input);
      } else {
        key = this.ctx.serializer.deserialize(input);
      }
    } catch (cause) {
      throw new ImportError("Failed to parse key for import", { cause });
    }
    this.ctx.validator.validateManagedKey(key);
    if (options.overwrite && (await this.hasKey(key.keyId))) {
      return this.replaceKey(key);
    }
    return this.storeKey(key);
  }

  /**
   * Export a key to a portable form. By default only public material is exported;
   * pass `includePrivate: true` to include secret material.
   * @throws {ExportError} if a public-only export is requested for secret-only material.
   */
  async exportKey(
    keyId: string,
    options: ExportKeyOptions = {},
  ): Promise<string | Uint8Array | SerializedKey> {
    let key = await this.getKey(keyId);
    if (!options.includePrivate) {
      try {
        key = key.toPublicOnly();
      } catch (cause) {
        throw new ExportError(
          `Cannot export a public-only form of a ${key.materialKind} key; pass includePrivate: true`,
          { cause, details: { keyId } },
        );
      }
    }
    switch (options.encoding ?? "json") {
      case "json":
        return this.ctx.serializer.toJSON(key);
      case "base64":
        return this.ctx.serializer.toBase64(key);
      case "binary":
        return this.ctx.serializer.toBinary(key);
      case "object":
        return this.ctx.serializer.serialize(key);
    }
  }

  // === rotation ============================================================

  /**
   * Rotate a key: create a new version (new id, `version+1`, `rotationCount+1`,
   * `previousKeyId` set) and mark the old one {@link KeyStatus.ROTATED}. The new
   * material comes from `options.generator`, or a type-appropriate default.
   *
   * @throws {RotationError} if no generator is available for the key's type.
   */
  async rotateKey(
    keyId: string,
    options: { generator?: MaterialGenerator } = {},
  ): Promise<RotationResult> {
    const previous = await this.getKey(keyId);
    const generator = options.generator ?? ((p) => this.defaultMaterial(p.metadata.type));
    const material = await generator(previous);
    const fingerprint = computeFingerprint(material);

    const metadata = createKeyMetadata(
      {
        type: previous.metadata.type,
        algorithm: this.algorithmOf(material),
        purpose: previous.metadata.purpose,
        owner: previous.metadata.owner,
        fingerprint,
        status: KeyStatus.ACTIVE,
        version: previous.metadata.version + 1,
        rotationCount: previous.metadata.rotationCount + 1,
        previousKeyId: previous.keyId,
        ...(previous.metadata.label !== undefined ? { label: previous.metadata.label } : {}),
        ...(previous.metadata.custom !== undefined ? { custom: previous.metadata.custom } : {}),
      },
      this.metaCtx,
    );
    const current = await this.storeKey(new ManagedKey({ metadata, material }));

    const retired = previous.withMetadata({
      status: KeyStatus.ROTATED,
      updatedAt: toIso(this.ctx.clock()),
    });
    await this.replaceKey(retired);
    return { previous: retired, current };
  }

  /** Evaluate a rotation policy over a set of keys (does NOT rotate). */
  async evaluateRotation(
    policy: RotationPolicy,
    filter?: StorageFilter,
    context?: RotationContext,
  ): Promise<RotationDecision[]> {
    const keys = await this.listKeys(filter);
    return this.scheduler.evaluate(keys, policy, context);
  }

  /** Reconstruct a key's rotation lineage (oldest-first) by following the chain. */
  async getHistory(keyId: string): Promise<KeyHistoryEntry[]> {
    const map = new Map<string, ManagedKey>();
    let current: string | undefined = keyId;
    let guard = 0;
    while (current && !map.has(current) && guard++ < 1000) {
      const key = await this.findKey(current);
      if (!key) break;
      map.set(current, key);
      current = key.metadata.previousKeyId;
    }
    return buildHistoryChain(keyId, map);
  }

  // === recovery (future hook) ==============================================

  /** Recover a key via the configured {@link RecoveryProvider}. */
  recoverKey(keyId: string): Promise<ManagedKey> {
    return this.recoveryProvider.recover(keyId);
  }

  /** Back up a key via the configured {@link RecoveryProvider}. */
  async backupKey(keyId: string): Promise<void> {
    const key = await this.getKey(keyId);
    return this.recoveryProvider.backup(key);
  }

  // === internals ===========================================================

  private repoFor(type: KeyType): BaseKeyRepository {
    return this.repos[type];
  }

  private build(
    type: KeyType,
    material: KeyMaterial,
    algorithm: string,
    purpose: KeyPurpose,
    options: GenerateKeyOptions,
  ): ManagedKey {
    const metadata = createKeyMetadata(
      {
        type,
        algorithm,
        purpose,
        owner: options.owner,
        fingerprint: computeFingerprint(material),
        ...(options.keyId !== undefined ? { keyId: options.keyId } : {}),
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.custom !== undefined ? { custom: options.custom } : {}),
      },
      this.metaCtx,
    );
    return new ManagedKey({ metadata, material });
  }

  private defaultMaterial(type: KeyType): KeyMaterial {
    switch (type) {
      case KeyType.IDENTITY:
        return { kind: KeyMaterialKind.KEYPAIR, keyPair: generateSigningKeyPair() };
      case KeyType.SESSION:
        return { kind: KeyMaterialKind.SYMMETRIC, symmetricKey: generateKey() };
      case KeyType.PREKEY:
      case KeyType.SIGNED_PREKEY:
      case KeyType.ONE_TIME_PREKEY:
        return { kind: KeyMaterialKind.KEYPAIR, keyPair: generateKeyPair() };
      default:
        throw new RotationError(
          `No default material generator for type "${type}"; pass options.generator`,
          { details: { type } },
        );
    }
  }

  private algorithmOf(material: KeyMaterial): string {
    switch (material.kind) {
      case KeyMaterialKind.SYMMETRIC:
        return material.symmetricKey.algorithm;
      case KeyMaterialKind.KEYPAIR:
        return material.keyPair.algorithm;
      case KeyMaterialKind.PUBLIC:
        return material.publicKey.algorithm;
      case KeyMaterialKind.SHARED_SECRET:
        return "shared-secret";
      case KeyMaterialKind.RAW:
        return "raw";
    }
  }
}

/** Re-exported for convenience (constructing key pairs in custom generators). */
export { KeyPair };

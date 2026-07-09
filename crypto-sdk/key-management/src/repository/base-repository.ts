/**
 * @module repository/base-repository
 *
 * {@link BaseKeyRepository} — the read/write abstraction over storage + cache +
 * serializer + validator for a single {@link KeyType}. Typed repositories extend
 * it. The cache is always consulted before storage.
 */

import type { Clock, KeyType, StorageFilter, StoredRecord } from "../types/index.js";
import { ManagedKey } from "../managed-key.js";
import { KeyNotFoundError, KeyValidationError } from "../errors/index.js";
import type { KeyStorage } from "../storage/index.js";
import type { KeyCache } from "../cache/index.js";
import type { KeySerializer } from "../serializers/index.js";
import type { KeyValidator } from "../validators/index.js";

/** Dependencies shared by all repositories (and the manager). */
export interface RepositoryContext {
  storage: KeyStorage;
  cache: KeyCache;
  serializer: KeySerializer;
  validator: KeyValidator;
  clock: Clock;
}

/**
 * Generic repository for one key type.
 *
 * @example
 * ```ts
 * class IdentityKeyRepository extends BaseKeyRepository {
 *   constructor(ctx: RepositoryContext) { super(KeyType.IDENTITY, ctx); }
 * }
 * ```
 */
export class BaseKeyRepository {
  constructor(
    /** The key type this repository manages. */
    public readonly type: KeyType,
    protected readonly ctx: RepositoryContext,
  ) {}

  /**
   * Validate and insert a new key.
   * @throws {KeyValidationError} if the key's type mismatches or validation fails.
   * @throws {DuplicateKeyError} if the id already exists.
   */
  async save(key: ManagedKey): Promise<ManagedKey> {
    this.assertType(key);
    this.ctx.validator.validateManagedKey(key);
    await this.ctx.storage.set(this.toRecord(key));
    this.ctx.cache.set(key.keyId, key);
    return key;
  }

  /** Fetch a key by id (cache → storage), or `null` if absent. */
  async findById(keyId: string): Promise<ManagedKey | null> {
    const cached = this.ctx.cache.get(keyId);
    if (cached) return cached;
    const record = await this.ctx.storage.get(keyId);
    if (!record || record.type !== this.type) return null;
    const key = this.fromRecord(record);
    this.ctx.cache.set(keyId, key);
    return key;
  }

  /** Fetch a key by id or throw. @throws {KeyNotFoundError} */
  async getById(keyId: string): Promise<ManagedKey> {
    const key = await this.findById(keyId);
    if (!key) throw new KeyNotFoundError(`Key ${keyId} not found`, { details: { keyId } });
    return key;
  }

  /** Whether a key exists (cache or storage). */
  async exists(keyId: string): Promise<boolean> {
    if (this.ctx.cache.has(keyId)) return true;
    return this.ctx.storage.has(keyId);
  }

  /**
   * Validate and replace an existing key (same id).
   * @throws {KeyNotFoundError} if it does not exist.
   */
  async replace(key: ManagedKey): Promise<ManagedKey> {
    this.assertType(key);
    this.ctx.validator.validateManagedKey(key);
    await this.ctx.storage.update(this.toRecord(key));
    this.ctx.cache.set(key.keyId, key);
    return key;
  }

  /** Delete a key from storage and cache; returns whether one was removed. */
  async delete(keyId: string): Promise<boolean> {
    this.ctx.cache.invalidate(keyId);
    return this.ctx.storage.delete(keyId);
  }

  /** List all keys of this type matching an optional (owner/status) filter. */
  async list(filter: Omit<StorageFilter, "type"> = {}): Promise<ManagedKey[]> {
    const records = await this.ctx.storage.list({ ...filter, type: this.type });
    return records.map((r) => this.fromRecord(r));
  }

  /** Count keys of this type matching an optional filter. */
  async count(filter: Omit<StorageFilter, "type"> = {}): Promise<number> {
    return this.ctx.storage.count({ ...filter, type: this.type });
  }

  /** All keys owned by `owner`. */
  findByOwner(owner: string): Promise<ManagedKey[]> {
    return this.list({ owner });
  }

  /** Active keys owned by `owner`. */
  findActiveByOwner(owner: string): Promise<ManagedKey[]> {
    return this.list({ owner, status: "active" as StorageFilter["status"] });
  }

  // --- internals -----------------------------------------------------------

  protected assertType(key: ManagedKey): void {
    if (key.metadata.type !== this.type) {
      throw new KeyValidationError(
        `Repository for ${this.type} received a ${key.metadata.type} key`,
        { details: { expected: this.type, actual: key.metadata.type, keyId: key.keyId } },
      );
    }
  }

  protected toRecord(key: ManagedKey): StoredRecord {
    return {
      keyId: key.metadata.keyId,
      type: key.metadata.type,
      owner: key.metadata.owner,
      status: key.metadata.status,
      version: key.metadata.version,
      createdAt: key.metadata.createdAt,
      updatedAt: key.metadata.updatedAt,
      payload: this.ctx.serializer.toJSON(key),
      encrypted: false,
    };
  }

  protected fromRecord(record: StoredRecord): ManagedKey {
    // Storage decorators (e.g. SecureStorage) return a decrypted plaintext payload.
    return this.ctx.serializer.fromJSON(record.payload);
  }
}

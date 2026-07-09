/**
 * @module storage/key-storage
 *
 * The storage abstraction. The rest of the KMS (and all future modules) depend
 * only on this async interface and never on where keys physically live.
 */

import type { StoredRecord, StorageFilter } from "../types/index.js";

/**
 * A pluggable key storage backend.
 *
 * All methods are async so real backends (databases, cloud KMS, HSMs) fit the
 * same contract as the in-memory reference implementation. Implementations MUST:
 * - `set`: insert; throw `DuplicateKeyError` if `keyId` already exists.
 * - `update`: replace; throw `KeyNotFoundError` if `keyId` is absent.
 * - never mutate the caller's `record` object or return internal references that
 *   the caller could mutate (return copies).
 */
export interface KeyStorage {
  /** Human-readable backend name (for logs/diagnostics). */
  readonly name: string;
  /** Whether this backend is usable in the current environment. */
  readonly available: boolean;

  /** Insert a new record. @throws {DuplicateKeyError} if the id exists. */
  set(record: StoredRecord): Promise<void>;
  /** Replace an existing record. @throws {KeyNotFoundError} if absent. */
  update(record: StoredRecord): Promise<void>;
  /** Fetch a record by id, or `null` if not found. */
  get(keyId: string): Promise<StoredRecord | null>;
  /** Whether a record exists. */
  has(keyId: string): Promise<boolean>;
  /** Delete a record; resolves `true` if one was removed. */
  delete(keyId: string): Promise<boolean>;
  /** List records matching an optional filter. */
  list(filter?: StorageFilter): Promise<StoredRecord[]>;
  /** Count records matching an optional filter. */
  count(filter?: StorageFilter): Promise<number>;
  /** Remove all records (primarily for tests / teardown). */
  clear(): Promise<void>;
}

/** Whether `record` satisfies every field present in `filter`. */
export function matchesFilter(record: StoredRecord, filter?: StorageFilter): boolean {
  if (!filter) return true;
  if (filter.owner !== undefined && record.owner !== filter.owner) return false;
  if (filter.type !== undefined && record.type !== filter.type) return false;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  return true;
}

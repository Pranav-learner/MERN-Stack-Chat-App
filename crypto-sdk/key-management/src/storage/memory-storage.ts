/**
 * @module storage/memory-storage
 *
 * Reference in-memory {@link KeyStorage} backed by a `Map`. Records are deep-copied
 * on the way in and out so stored state is fully isolated from callers. Suitable
 * for tests, ephemeral processes, and as the default backend.
 */

import type { StoredRecord, StorageFilter } from "../types/index.js";
import { DuplicateKeyError, KeyNotFoundError } from "../errors/index.js";
import { KeyStorage, matchesFilter } from "./key-storage.js";

/** In-memory key storage. Not persistent; not shared across processes. */
export class MemoryStorage implements KeyStorage {
  public readonly name = "memory";
  public readonly available = true;

  private readonly records = new Map<string, StoredRecord>();

  async set(record: StoredRecord): Promise<void> {
    if (this.records.has(record.keyId)) {
      throw new DuplicateKeyError(`Key ${record.keyId} already exists`, {
        details: { keyId: record.keyId },
      });
    }
    this.records.set(record.keyId, structuredClone(record));
  }

  async update(record: StoredRecord): Promise<void> {
    if (!this.records.has(record.keyId)) {
      throw new KeyNotFoundError(`Key ${record.keyId} not found`, { details: { keyId: record.keyId } });
    }
    this.records.set(record.keyId, structuredClone(record));
  }

  async get(keyId: string): Promise<StoredRecord | null> {
    const rec = this.records.get(keyId);
    return rec ? structuredClone(rec) : null;
  }

  async has(keyId: string): Promise<boolean> {
    return this.records.has(keyId);
  }

  async delete(keyId: string): Promise<boolean> {
    return this.records.delete(keyId);
  }

  async list(filter?: StorageFilter): Promise<StoredRecord[]> {
    const out: StoredRecord[] = [];
    for (const rec of this.records.values()) {
      if (matchesFilter(rec, filter)) out.push(structuredClone(rec));
    }
    return out;
  }

  async count(filter?: StorageFilter): Promise<number> {
    if (!filter) return this.records.size;
    let n = 0;
    for (const rec of this.records.values()) if (matchesFilter(rec, filter)) n++;
    return n;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

/**
 * @module storage/placeholders
 *
 * Interface-conformant placeholders for storage backends that later layers will
 * implement. They exist so wiring and dependency injection can be written now
 * against the real {@link KeyStorage} contract. Every operation throws
 * {@link StorageFailureError}; each backend reports `available = false`.
 *
 * These deliberately contain NO real integration (no DB driver, no cloud SDK, no
 * HSM binding) — that is out of scope for Sprint 2.
 */

import type { StoredRecord, StorageFilter } from "../types/index.js";
import { StorageFailureError } from "../errors/index.js";
import { KeyStorage } from "./key-storage.js";

abstract class UnavailableStorage implements KeyStorage {
  abstract readonly name: string;
  public readonly available = false;

  private unavailable(op: string): Promise<never> {
    return Promise.reject(
      new StorageFailureError(`${this.name} storage is not implemented in Sprint 2 (op: ${op})`, {
        details: { backend: this.name, op },
      }),
    );
  }

  set(_record: StoredRecord): Promise<void> {
    return this.unavailable("set");
  }
  update(_record: StoredRecord): Promise<void> {
    return this.unavailable("update");
  }
  get(_keyId: string): Promise<StoredRecord | null> {
    return this.unavailable("get");
  }
  has(_keyId: string): Promise<boolean> {
    return this.unavailable("has");
  }
  delete(_keyId: string): Promise<boolean> {
    return this.unavailable("delete");
  }
  list(_filter?: StorageFilter): Promise<StoredRecord[]> {
    return this.unavailable("list");
  }
  count(_filter?: StorageFilter): Promise<number> {
    return this.unavailable("count");
  }
  clear(): Promise<void> {
    return this.unavailable("clear");
  }
}

/** Future persistent database backend (e.g. Postgres/Mongo). Not implemented. */
export class DatabaseStorage extends UnavailableStorage {
  public readonly name = "database";
  constructor(public readonly config: Record<string, unknown> = {}) {
    super();
  }
}

/** Future hardware-security-module backend. Not implemented. */
export class HardwareStorage extends UnavailableStorage {
  public readonly name = "hardware";
  constructor(public readonly config: Record<string, unknown> = {}) {
    super();
  }
}

/** Future cloud KMS backend (AWS KMS / GCP KMS / Vault). Not implemented. */
export class CloudKmsStorage extends UnavailableStorage {
  public readonly name = "cloud-kms";
  constructor(public readonly config: Record<string, unknown> = {}) {
    super();
  }
}

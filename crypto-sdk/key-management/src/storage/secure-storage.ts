/**
 * @module storage/secure-storage
 *
 * A {@link KeyStorage} decorator that encrypts the sensitive `payload` (the
 * serialized key material) at rest using the Crypto SDK's AES-256-GCM, before
 * delegating to an inner backend. Index fields (keyId, owner, type, status,
 * version, timestamps) remain in cleartext so the inner backend can still query.
 *
 * The master key is supplied by the caller (e.g. derived from a passphrase via
 * the SDK's `deriveKeyFromPassword`, or provided by an outer KMS). This class
 * never persists the master key.
 *
 * DESIGN NOTE: only `payload` is encrypted; metadata used for indexing is not.
 * Callers needing metadata confidentiality should encrypt at the inner-backend
 * layer instead. The `keyId` is bound as AEAD associated data, so a ciphertext
 * cannot be moved to a different record id without detection.
 */

import {
  EncryptedPayload,
  SymmetricKey,
  decrypt,
  encrypt,
  utf8ToBytes,
  bytesToUtf8,
} from "@securechat/crypto-sdk";
import type { StoredRecord, StorageFilter } from "../types/index.js";
import { StorageFailureError } from "../errors/index.js";
import { KeyStorage } from "./key-storage.js";

/** Encrypts key payloads at rest over any inner {@link KeyStorage}. */
export class SecureStorage implements KeyStorage {
  public readonly name: string;
  public readonly available = true;

  constructor(
    private readonly inner: KeyStorage,
    private readonly masterKey: SymmetricKey,
  ) {
    this.name = `secure(${inner.name})`;
  }

  async set(record: StoredRecord): Promise<void> {
    return this.inner.set(this.seal(record));
  }

  async update(record: StoredRecord): Promise<void> {
    return this.inner.update(this.seal(record));
  }

  async get(keyId: string): Promise<StoredRecord | null> {
    const rec = await this.inner.get(keyId);
    return rec ? this.open(rec) : null;
  }

  async has(keyId: string): Promise<boolean> {
    return this.inner.has(keyId);
  }

  async delete(keyId: string): Promise<boolean> {
    return this.inner.delete(keyId);
  }

  async list(filter?: StorageFilter): Promise<StoredRecord[]> {
    const recs = await this.inner.list(filter);
    return recs.map((r) => this.open(r));
  }

  async count(filter?: StorageFilter): Promise<number> {
    return this.inner.count(filter);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }

  /** Encrypt the payload, binding the keyId as AAD. */
  private seal(record: StoredRecord): StoredRecord {
    if (record.encrypted) return record; // already sealed
    try {
      const payloadBytes = utf8ToBytes(record.payload);
      const envelope = encrypt(this.masterKey, payloadBytes, { aad: utf8ToBytes(record.keyId) });
      return { ...record, payload: envelope.serialize(), encrypted: true };
    } catch (cause) {
      throw new StorageFailureError("Failed to encrypt key payload for storage", {
        cause,
        details: { keyId: record.keyId },
      });
    }
  }

  /** Decrypt the payload, verifying the keyId AAD binding. */
  private open(record: StoredRecord): StoredRecord {
    if (!record.encrypted) return record;
    try {
      const envelope = EncryptedPayload.deserialize(record.payload);
      const plaintext = decrypt(this.masterKey, envelope, { aad: utf8ToBytes(record.keyId) });
      return { ...record, payload: bytesToUtf8(plaintext), encrypted: false };
    } catch (cause) {
      throw new StorageFailureError("Failed to decrypt key payload from storage", {
        cause,
        details: { keyId: record.keyId },
      });
    }
  }
}

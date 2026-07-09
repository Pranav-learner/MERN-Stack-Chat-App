/**
 * @module recovery
 *
 * Key-recovery abstraction (future hook). Defines the contract a later layer will
 * implement (e.g. Shamir secret sharing, escrow, social recovery, cloud backup)
 * and ships a {@link NoopRecoveryProvider} default so the {@link KeyManager} can
 * wire recovery now without providing a real one.
 */

import type { ManagedKey } from "../managed-key.js";
import { RecoveryError } from "../errors/index.js";

/** Pluggable recovery/backup provider. */
export interface RecoveryProvider {
  readonly name: string;
  /** Whether this provider can recover the given key id. */
  canRecover(keyId: string): Promise<boolean>;
  /** Recover a key by id. @throws {RecoveryError} if unsupported/unavailable. */
  recover(keyId: string): Promise<ManagedKey>;
  /** Back up a key for later recovery. @throws {RecoveryError} if unsupported. */
  backup(key: ManagedKey): Promise<void>;
}

/**
 * Default provider that recovers/backs up nothing. Present so recovery can be
 * dependency-injected before a real implementation exists.
 */
export class NoopRecoveryProvider implements RecoveryProvider {
  public readonly name = "noop";

  async canRecover(): Promise<boolean> {
    return false;
  }

  async recover(keyId: string): Promise<ManagedKey> {
    throw new RecoveryError("Key recovery is not implemented in Sprint 2", { details: { keyId } });
  }

  async backup(key: ManagedKey): Promise<void> {
    throw new RecoveryError("Key backup is not implemented in Sprint 2", {
      details: { keyId: key.keyId },
    });
  }
}

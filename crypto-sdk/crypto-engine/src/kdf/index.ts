/**
 * @module kdf
 *
 * A key-derivation *framework* on top of Sprint 1's HKDF/scrypt. It formalizes
 * context and purpose separation so future modules derive independent keys from
 * a single high-entropy master secret without hand-building HKDF `info` labels.
 *
 * Core ideas:
 * - {@link MasterKey} — wraps high-entropy master material (random, shared secret,
 *   or password-stretched) and derives sub-keys / sub-masters.
 * - {@link KeyDerivation} — an ergonomic engine bound to a namespace that derives
 *   symmetric/session keys by `(context, purpose)`.
 * - The HKDF `info` label is `"<namespace>:<context>:<purpose>:v<version>"`, so
 *   changing any axis yields an independent key.
 */

import {
  SharedSecret,
  SymmetricKey,
  deriveKeyFromPassword,
  hkdf,
  randomBytes,
  utf8ToBytes,
} from "@securechat/crypto-sdk";
import {
  DerivationPurpose,
  type DerivationContext,
  type DeriveOptions,
} from "../types/index.js";
import { DerivationError } from "../errors/index.js";
import { cloneBytes, wipe } from "../security/index.js";

/** Default top-level namespace for derivation labels. */
export const DEFAULT_NAMESPACE = "securechat";

/** Build the HKDF `info` label from a derivation context. */
export function buildInfoLabel(context: DerivationContext): Uint8Array {
  const namespace = context.namespace ?? DEFAULT_NAMESPACE;
  const version = context.version ?? 1;
  return utf8ToBytes(`${namespace}:${context.context}:${context.purpose}:v${version}`);
}

/**
 * High-entropy master key material with HKDF-based derivation.
 *
 * @example
 * ```ts
 * const master = MasterKey.random();
 * const encKey = master.deriveSymmetricKey({ context: "session", purpose: DerivationPurpose.ENCRYPTION });
 * const macKey = master.deriveSymmetricKey({ context: "session", purpose: DerivationPurpose.MAC });
 * // encKey !== macKey — independent by purpose.
 * ```
 */
export class MasterKey {
  private readonly _bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    if (bytes.length < 16) {
      throw new DerivationError("Master key must be at least 16 bytes of high-entropy material");
    }
    this._bytes = cloneBytes(bytes);
  }

  /** Generate a random master key (default 32 bytes). */
  static random(length = 32): MasterKey {
    return new MasterKey(randomBytes(length));
  }

  /** Wrap existing high-entropy bytes (>= 16 bytes). */
  static fromBytes(bytes: Uint8Array): MasterKey {
    return new MasterKey(bytes);
  }

  /** Use a Diffie–Hellman {@link SharedSecret} as the master key material. */
  static fromSharedSecret(secret: SharedSecret): MasterKey {
    return new MasterKey(secret.bytes);
  }

  /**
   * Stretch a low-entropy password into a master key with scrypt (memory-hard).
   * A unique random `salt` MUST be supplied and stored alongside.
   */
  static fromPassword(
    password: Uint8Array | string,
    salt: Uint8Array | string,
    options: { length?: number; cost?: number } = {},
  ): MasterKey {
    const bytes = deriveKeyFromPassword(password, salt, {
      length: options.length ?? 32,
      ...(options.cost !== undefined ? { cost: options.cost } : {}),
    });
    return new MasterKey(bytes);
  }

  /** Derive raw key bytes for a `(context, purpose)`. */
  deriveBytes(context: DerivationContext, options: DeriveOptions = {}): Uint8Array {
    try {
      const derivationContext: DerivationContext = { ...context };
      if (options.version !== undefined) derivationContext.version = options.version;
      const hkdfOptions: Parameters<typeof hkdf>[1] = {
        info: buildInfoLabel(derivationContext),
        length: options.length ?? 32,
      };
      if (options.salt !== undefined) hkdfOptions.salt = options.salt;
      return hkdf(this._bytes, hkdfOptions);
    } catch (cause) {
      throw new DerivationError("Failed to derive key bytes", { cause });
    }
  }

  /** Derive a 32-byte {@link SymmetricKey} for a `(context, purpose)`. */
  deriveSymmetricKey(context: DerivationContext, options: Omit<DeriveOptions, "length"> = {}): SymmetricKey {
    return SymmetricKey.fromBytes(this.deriveBytes(context, { ...options, length: 32 }));
  }

  /**
   * Derive a child {@link MasterKey} (hierarchical derivation) for a sub-domain.
   * The child can itself derive further keys, enabling key trees.
   */
  deriveMasterKey(context: DerivationContext, options: DeriveOptions = {}): MasterKey {
    return new MasterKey(this.deriveBytes(context, { ...options, length: options.length ?? 32 }));
  }

  /** Best-effort zeroing of the master material. */
  destroy(): void {
    wipe(this._bytes);
  }

  /** Avoid leaking secret material via logs / JSON. */
  toJSON(): string {
    return "[MasterKey]";
  }
}

/**
 * Ergonomic derivation engine bound to a namespace and master key. Ideal when a
 * subsystem derives many keys and wants terse `(context, purpose)` calls.
 *
 * @example
 * ```ts
 * const kd = KeyDerivation.random("securechat");
 * const key = kd.deriveSymmetricKey("file", DerivationPurpose.ENCRYPTION);
 * const session = kd.deriveSessionKey("peer-42");
 * ```
 */
export class KeyDerivation {
  constructor(
    private readonly master: MasterKey,
    /** Namespace applied to every derivation (default `"securechat"`). */
    public readonly namespace: string = DEFAULT_NAMESPACE,
  ) {}

  /** Create an engine with a fresh random master key. */
  static random(namespace = DEFAULT_NAMESPACE): KeyDerivation {
    return new KeyDerivation(MasterKey.random(), namespace);
  }

  /** Create an engine whose master key is a {@link SharedSecret}. */
  static fromSharedSecret(secret: SharedSecret, namespace = DEFAULT_NAMESPACE): KeyDerivation {
    return new KeyDerivation(MasterKey.fromSharedSecret(secret), namespace);
  }

  /** Create an engine from an existing {@link MasterKey}. */
  static fromMasterKey(master: MasterKey, namespace = DEFAULT_NAMESPACE): KeyDerivation {
    return new KeyDerivation(master, namespace);
  }

  /** Derive a symmetric key for `(context, purpose)`. */
  deriveSymmetricKey(
    context: string,
    purpose: DerivationPurpose | string = DerivationPurpose.ENCRYPTION,
    options: Omit<DeriveOptions, "length"> = {},
  ): SymmetricKey {
    return this.master.deriveSymmetricKey({ namespace: this.namespace, context, purpose }, options);
  }

  /** Derive raw bytes for `(context, purpose)`. */
  deriveBytes(
    context: string,
    purpose: DerivationPurpose | string,
    options: DeriveOptions = {},
  ): Uint8Array {
    return this.master.deriveBytes({ namespace: this.namespace, context, purpose }, options);
  }

  /**
   * Derive a session encryption key for a context (e.g. a peer/session id). A
   * convenience over {@link deriveSymmetricKey} with the ENCRYPTION purpose.
   */
  deriveSessionKey(context: string, options: Omit<DeriveOptions, "length"> = {}): SymmetricKey {
    return this.deriveSymmetricKey(context, DerivationPurpose.ENCRYPTION, options);
  }
}

/**
 * One-shot helper: derive a session {@link SymmetricKey} directly from a
 * {@link SharedSecret} for a context. Wraps the SDK's `SharedSecret.deriveKey`
 * with a consistent info label.
 *
 * @example
 * ```ts
 * const key = deriveSessionKey(sharedSecret, "peer-42");
 * ```
 */
export function deriveSessionKey(
  secret: SharedSecret,
  context: string,
  options: { namespace?: string; salt?: Uint8Array | string; version?: number } = {},
): SymmetricKey {
  const info = buildInfoLabel({
    namespace: options.namespace ?? DEFAULT_NAMESPACE,
    context,
    purpose: DerivationPurpose.ENCRYPTION,
    ...(options.version !== undefined ? { version: options.version } : {}),
  });
  const deriveOptions: Parameters<SharedSecret["deriveKey"]>[0] = { info };
  if (options.salt !== undefined) deriveOptions.salt = options.salt;
  return secret.deriveKey(deriveOptions);
}

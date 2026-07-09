/**
 * {@link PublicKey}, {@link PrivateKey}, and {@link KeyPair} — thin, typed wrappers
 * around Node's `KeyObject` for the X25519 (key agreement) and Ed25519 (signing)
 * curves. These carry their {@link AsymmetricAlgorithm} so the higher-level
 * `asymmetric` and `signatures` modules can enforce correct usage.
 *
 * Import/export matrix:
 *
 * | Format | Public (import/export) | Private (import/export) |
 * |--------|------------------------|-------------------------|
 * | RAW    | ✅ / ✅ (32-byte point) | ❌ / ✅ (see note)       |
 * | DER    | ✅ / ✅ (SPKI)          | ✅ / ✅ (PKCS#8)         |
 * | PEM    | ✅ / ✅ (SPKI)          | ✅ / ✅ (PKCS#8)         |
 * | JWK    | ✅ / ✅ (OKP)           | ✅ / ✅ (OKP)            |
 *
 * NOTE on RAW private import: reconstructing a private `KeyObject` from only the
 * 32-byte scalar requires re-deriving the public point (a curve operation). To
 * avoid re-implementing curve math, RAW *import* of private keys is intentionally
 * unsupported; use JWK/DER/PEM (all lossless) instead. RAW *export* returns the
 * private scalar `d` for inspection/interop.
 */

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";
import { AsymmetricAlgorithm, KeyFormat } from "../constants/index.js";
import { InvalidKeyError, KeyExportError, KeyImportError } from "../errors/index.js";
import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "../encoding/index.js";
import { constantTimeEqual } from "../utils/index.js";

/** RFC 8037 JWK curve name for each supported algorithm. */
const JWK_CRV: Record<AsymmetricAlgorithm, "X25519" | "Ed25519"> = {
  [AsymmetricAlgorithm.X25519]: "X25519",
  [AsymmetricAlgorithm.ED25519]: "Ed25519",
};

function assertMatchingType(key: KeyObject, algorithm: AsymmetricAlgorithm): void {
  if (key.asymmetricKeyType !== algorithm) {
    throw new KeyImportError(
      `Key type mismatch: expected ${algorithm}, got ${String(key.asymmetricKeyType)}`,
    );
  }
}

/**
 * An asymmetric public key (X25519 or Ed25519).
 */
export class PublicKey {
  private constructor(
    private readonly keyObject: KeyObject,
    /** The curve this key belongs to. */
    public readonly algorithm: AsymmetricAlgorithm,
  ) {}

  /** Internal: wrap a Node KeyObject (used by the SDK, not typical app code). */
  static fromKeyObject(keyObject: KeyObject, algorithm: AsymmetricAlgorithm): PublicKey {
    if (keyObject.type !== "public") {
      throw new InvalidKeyError("Expected a public KeyObject");
    }
    assertMatchingType(keyObject, algorithm);
    return new PublicKey(keyObject, algorithm);
  }

  /**
   * Import from the raw 32-byte curve point.
   * @throws {KeyImportError} if the bytes are not a valid point for `algorithm`.
   */
  static fromRaw(raw: Uint8Array, algorithm: AsymmetricAlgorithm): PublicKey {
    try {
      const keyObject = createPublicKey({
        key: { kty: "OKP", crv: JWK_CRV[algorithm], x: toBase64Url(raw) } as JsonWebKey,
        format: "jwk",
      });
      return PublicKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import raw ${algorithm} public key`, { cause });
    }
  }

  /** Import from base64-encoded raw bytes. */
  static fromBase64(b64: string, algorithm: AsymmetricAlgorithm): PublicKey {
    return PublicKey.fromRaw(fromBase64(b64), algorithm);
  }

  /** Import from DER (SPKI). @throws {KeyImportError} */
  static fromDER(der: Uint8Array, algorithm: AsymmetricAlgorithm): PublicKey {
    try {
      const keyObject = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
      return PublicKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import DER ${algorithm} public key`, { cause });
    }
  }

  /** Import from PEM (SPKI). @throws {KeyImportError} */
  static fromPEM(pem: string, algorithm: AsymmetricAlgorithm): PublicKey {
    try {
      const keyObject = createPublicKey({ key: pem, format: "pem" });
      return PublicKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import PEM ${algorithm} public key`, { cause });
    }
  }

  /** Import from a JWK object (OKP). @throws {KeyImportError} */
  static fromJWK(jwk: JsonWebKey, algorithm: AsymmetricAlgorithm): PublicKey {
    try {
      const keyObject = createPublicKey({ key: jwk, format: "jwk" });
      return PublicKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import JWK ${algorithm} public key`, { cause });
    }
  }

  /** Raw 32-byte curve point. */
  toRaw(): Uint8Array {
    try {
      const jwk = this.keyObject.export({ format: "jwk" });
      if (!jwk.x) throw new KeyExportError("JWK missing 'x' coordinate");
      return fromBase64Url(jwk.x);
    } catch (cause) {
      if (cause instanceof KeyExportError) throw cause;
      throw new KeyExportError("Failed to export raw public key", { cause });
    }
  }

  /** Raw curve point, base64-encoded. */
  toBase64(): string {
    return toBase64(this.toRaw());
  }

  /** DER (SPKI) encoding. */
  toDER(): Uint8Array {
    try {
      return new Uint8Array(this.keyObject.export({ type: "spki", format: "der" }));
    } catch (cause) {
      throw new KeyExportError("Failed to export public key as DER", { cause });
    }
  }

  /** PEM (SPKI) text. */
  toPEM(): string {
    try {
      return this.keyObject.export({ type: "spki", format: "pem" }) as string;
    } catch (cause) {
      throw new KeyExportError("Failed to export public key as PEM", { cause });
    }
  }

  /** JWK (OKP) object. */
  toJWK(): JsonWebKey {
    try {
      return this.keyObject.export({ format: "jwk" });
    } catch (cause) {
      throw new KeyExportError("Failed to export public key as JWK", { cause });
    }
  }

  /**
   * Generic export dispatching on {@link KeyFormat}.
   * RAW/DER return {@link Uint8Array}; PEM returns a string; JWK returns an object.
   */
  export(format: KeyFormat = KeyFormat.RAW): Uint8Array | string | JsonWebKey {
    switch (format) {
      case KeyFormat.RAW:
        return this.toRaw();
      case KeyFormat.DER:
        return this.toDER();
      case KeyFormat.PEM:
        return this.toPEM();
      case KeyFormat.JWK:
        return this.toJWK();
      default:
        throw new KeyExportError(`Unsupported public key export format: ${String(format)}`);
    }
  }

  /** Underlying Node KeyObject — for internal use by the SDK's crypto modules. */
  get native(): KeyObject {
    return this.keyObject;
  }

  /** Constant-time structural equality against another public key (same curve + point). */
  equals(other: PublicKey): boolean {
    if (this.algorithm !== other.algorithm) return false;
    return constantTimeEqual(this.toRaw(), other.toRaw());
  }
}

/**
 * An asymmetric private key (X25519 or Ed25519).
 */
export class PrivateKey {
  private constructor(
    private readonly keyObject: KeyObject,
    /** The curve this key belongs to. */
    public readonly algorithm: AsymmetricAlgorithm,
  ) {}

  /** Internal: wrap a Node KeyObject. */
  static fromKeyObject(keyObject: KeyObject, algorithm: AsymmetricAlgorithm): PrivateKey {
    if (keyObject.type !== "private") {
      throw new InvalidKeyError("Expected a private KeyObject");
    }
    assertMatchingType(keyObject, algorithm);
    return new PrivateKey(keyObject, algorithm);
  }

  /** Import from DER (PKCS#8). @throws {KeyImportError} */
  static fromDER(der: Uint8Array, algorithm: AsymmetricAlgorithm): PrivateKey {
    try {
      const keyObject = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
      return PrivateKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import DER ${algorithm} private key`, { cause });
    }
  }

  /** Import from PEM (PKCS#8). @throws {KeyImportError} */
  static fromPEM(pem: string, algorithm: AsymmetricAlgorithm): PrivateKey {
    try {
      const keyObject = createPrivateKey({ key: pem, format: "pem" });
      return PrivateKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import PEM ${algorithm} private key`, { cause });
    }
  }

  /** Import from a JWK object (OKP, includes `d`). @throws {KeyImportError} */
  static fromJWK(jwk: JsonWebKey, algorithm: AsymmetricAlgorithm): PrivateKey {
    try {
      const keyObject = createPrivateKey({ key: jwk, format: "jwk" });
      return PrivateKey.fromKeyObject(keyObject, algorithm);
    } catch (cause) {
      if (cause instanceof KeyImportError) throw cause;
      throw new KeyImportError(`Failed to import JWK ${algorithm} private key`, { cause });
    }
  }

  /** Derive the matching {@link PublicKey}. */
  toPublicKey(): PublicKey {
    return PublicKey.fromKeyObject(createPublicKey(this.keyObject), this.algorithm);
  }

  /**
   * Raw 32-byte private scalar `d`.
   * SECURITY: this is secret material — handle and store with care.
   */
  toRaw(): Uint8Array {
    try {
      const jwk = this.keyObject.export({ format: "jwk" });
      if (!jwk.d) throw new KeyExportError("JWK missing 'd' value");
      return fromBase64Url(jwk.d);
    } catch (cause) {
      if (cause instanceof KeyExportError) throw cause;
      throw new KeyExportError("Failed to export raw private key", { cause });
    }
  }

  /** DER (PKCS#8) encoding. Secret material. */
  toDER(): Uint8Array {
    try {
      return new Uint8Array(this.keyObject.export({ type: "pkcs8", format: "der" }));
    } catch (cause) {
      throw new KeyExportError("Failed to export private key as DER", { cause });
    }
  }

  /** PEM (PKCS#8) text. Secret material. */
  toPEM(): string {
    try {
      return this.keyObject.export({ type: "pkcs8", format: "pem" }) as string;
    } catch (cause) {
      throw new KeyExportError("Failed to export private key as PEM", { cause });
    }
  }

  /** JWK (OKP) object including `d`. Secret material. */
  toJWK(): JsonWebKey {
    try {
      return this.keyObject.export({ format: "jwk" });
    } catch (cause) {
      throw new KeyExportError("Failed to export private key as JWK", { cause });
    }
  }

  /**
   * Generic export dispatching on {@link KeyFormat}.
   * RAW is the private scalar; DER/PEM are PKCS#8; JWK is the OKP object.
   * @throws {KeyExportError} for an unsupported format.
   */
  export(format: KeyFormat = KeyFormat.DER): Uint8Array | string | JsonWebKey {
    switch (format) {
      case KeyFormat.RAW:
        return this.toRaw();
      case KeyFormat.DER:
        return this.toDER();
      case KeyFormat.PEM:
        return this.toPEM();
      case KeyFormat.JWK:
        return this.toJWK();
      default:
        throw new KeyExportError(`Unsupported private key export format: ${String(format)}`);
    }
  }

  /** Underlying Node KeyObject — for internal use by the SDK's crypto modules. */
  get native(): KeyObject {
    return this.keyObject;
  }

  /** Avoid accidental secret leakage in logs / `JSON.stringify`. */
  toJSON(): string {
    return "[PrivateKey]";
  }
}

/**
 * A matched ({@link PublicKey}, {@link PrivateKey}) pair on a single curve.
 *
 * @example
 * ```ts
 * const kp = KeyPair.generate(AsymmetricAlgorithm.X25519);
 * const pub = kp.publicKey.toRaw(); // share this
 * ```
 */
export class KeyPair {
  constructor(
    public readonly publicKey: PublicKey,
    public readonly privateKey: PrivateKey,
  ) {
    if (publicKey.algorithm !== privateKey.algorithm) {
      throw new InvalidKeyError("KeyPair public and private keys must use the same algorithm");
    }
  }

  /** The curve of this key pair. */
  get algorithm(): AsymmetricAlgorithm {
    return this.publicKey.algorithm;
  }

  /**
   * Generate a fresh key pair on the given curve.
   * @throws {InvalidKeyError} if generation fails.
   */
  static generate(algorithm: AsymmetricAlgorithm): KeyPair {
    try {
      const { publicKey, privateKey } =
        algorithm === AsymmetricAlgorithm.ED25519
          ? generateKeyPairSync("ed25519")
          : generateKeyPairSync("x25519");
      return new KeyPair(
        PublicKey.fromKeyObject(publicKey, algorithm),
        PrivateKey.fromKeyObject(privateKey, algorithm),
      );
    } catch (cause) {
      if (cause instanceof InvalidKeyError) throw cause;
      throw new InvalidKeyError(`Failed to generate ${algorithm} key pair`, { cause });
    }
  }

  /** Reconstruct a pair from an existing private key (deriving the public key). */
  static fromPrivateKey(privateKey: PrivateKey): KeyPair {
    return new KeyPair(privateKey.toPublicKey(), privateKey);
  }
}

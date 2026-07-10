/**
 * @module key-hierarchy/derivation
 *
 * The cryptographic derivation for the key hierarchy — all HKDF-SHA256, all deterministic,
 * all byte-compatible with the browser's Web Crypto (as elsewhere in Layer 4/5).
 *
 * ```
 * rootSecret ──HKDF("root|gen=G")──▶ Root Key
 *                                       │
 *                 ┌─────────────────────┴─────────────────────┐
 *        HKDF("chain-init|i2r|gen=G")            HKDF("chain-init|r2i|gen=G")
 *                 │                                             │
 *            Chain Key (i2r, index 0)                     Chain Key (r2i, index 0)
 *                 │  advanceChainKey (one-way, per index)       │
 *            Chain Key (i2r, index 1) ...                  Chain Key (r2i, index 1) ...
 * ```
 *
 * @security **Chain advancement is one-way** (`CKₙ₊₁ = HKDF(CKₙ)`) — a leaked later chain
 * key cannot recover an earlier one, which is the forward-secrecy property the per-message
 * keys of Sprint 5 will inherit. The two direction chains (`i2r`/`r2i`) use distinct labels
 * so they evolve **independently**. Both peers derive an identical hierarchy from the same
 * `rootSecret` (the Sprint 2 generation's `ratchetMaterial`), so **no key is transmitted**.
 *
 * @hierarchy Message-key derivation from a chain key is intentionally NOT implemented here
 * — {@link messageKeyLabel} exposes the exact label Sprint 5 will use, as an extension point.
 */

import crypto from "node:crypto";
import { KH_NAMESPACE, KH_VERSION, KH_KEY_BYTES, ChainDirection, DeviceRole } from "../types/types.js";
import { KeyHierarchyDerivationError } from "../errors.js";

/** HKDF-SHA256 into `length` bytes. */
function hkdf(secret, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, length));
}

/** Per-session salt binding the hierarchy to the session/handshake (domain separation). */
export function hierarchySalt(context) {
  return Buffer.from(`${KH_NAMESPACE}-salt|v${KH_VERSION}|sid=${context.sessionId}|hs=${context.handshakeId ?? ""}`, "utf8");
}

/** An HKDF `info` label. */
function label(kind, ...parts) {
  return Buffer.from(`${KH_NAMESPACE}|v${KH_VERSION}|${kind}${parts.length ? "|" + parts.join("|") : ""}`, "utf8");
}

/**
 * Derive the **Session Root Key** from a root secret (the Sprint 2 generation's
 * `ratchetMaterial`). Domain-separated from all other Layer 4/5 derivations.
 * @param {Buffer|Uint8Array} rootSecret the device-local root secret
 * @param {{ sessionId: string, handshakeId?: string, generation?: number }} context
 * @returns {Buffer} the 32-byte root key — DEVICE-LOCAL; never serialize
 * @throws {KeyHierarchyDerivationError}
 */
export function deriveRootKey(rootSecret, context) {
  const secret = Buffer.isBuffer(rootSecret) ? rootSecret : Buffer.from(rootSecret ?? []);
  if (secret.length === 0) throw new KeyHierarchyDerivationError("A non-empty root secret is required");
  try {
    return hkdf(secret, hierarchySalt(context), label("root", `gen=${context.generation ?? 0}`), KH_KEY_BYTES);
  } catch (error) {
    throw new KeyHierarchyDerivationError("Failed to derive the root key", { cause: error });
  }
}

/**
 * Derive a direction chain's INITIAL chain key (index 0) from the root key.
 * @param {Buffer} rootKey @param {string} direction one of {@link ChainDirection}
 * @param {{ sessionId: string, handshakeId?: string, generation?: number }} context
 * @returns {Buffer} the 32-byte chain key — DEVICE-LOCAL
 * @throws {KeyHierarchyDerivationError}
 */
export function deriveChainKey(rootKey, direction, context) {
  if (!Buffer.isBuffer(rootKey) || rootKey.length === 0) throw new KeyHierarchyDerivationError("A root key is required to derive a chain");
  try {
    return hkdf(rootKey, hierarchySalt(context), label("chain-init", direction, `gen=${context.generation ?? 0}`), KH_KEY_BYTES);
  } catch (error) {
    throw new KeyHierarchyDerivationError("Failed to derive the chain key", { cause: error });
  }
}

/**
 * Advance a chain key one step (the chain-key ratchet). One-way: the input cannot be
 * recovered from the output.
 * @param {Buffer} chainKey the current chain key
 * @param {{ sessionId: string, handshakeId?: string }} context @param {number} nextIndex
 * @returns {Buffer} the next 32-byte chain key — DEVICE-LOCAL
 * @throws {KeyHierarchyDerivationError}
 */
export function advanceChainKey(chainKey, context, nextIndex) {
  if (!Buffer.isBuffer(chainKey) || chainKey.length === 0) throw new KeyHierarchyDerivationError("A chain key is required to advance");
  try {
    return hkdf(chainKey, hierarchySalt(context), label("chain-advance", `index=${nextIndex}`), KH_KEY_BYTES);
  } catch (error) {
    throw new KeyHierarchyDerivationError("Failed to advance the chain key", { cause: error });
  }
}

/**
 * The PUBLIC fingerprint of a key (a SHA-256 commitment) — safe to store/serialize.
 * @param {Buffer} key @returns {string} hex
 */
export function keyFingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * A PUBLIC, stable key id for a key at a position (domain-separated hash prefix).
 * @param {Buffer} key @param {string} tag e.g. "root" | direction
 * @param {number} [index] @returns {string} 32-hex id
 */
export function keyId(key, tag, index = 0) {
  return crypto.createHash("sha256").update(`${KH_NAMESPACE}|id|${tag}|${index}`).update(key).digest("hex").slice(0, 32);
}

/**
 * The device's sending/receiving directions given its role. Peer-symmetric: an initiator's
 * sending direction (`i2r`) is the responder's receiving direction.
 * @param {string} role one of {@link DeviceRole}
 * @returns {{ sending: string, receiving: string }}
 */
export function directionsForRole(role) {
  return role === DeviceRole.RESPONDER
    ? { sending: ChainDirection.R2I, receiving: ChainDirection.I2R }
    : { sending: ChainDirection.I2R, receiving: ChainDirection.R2I };
}

/**
 * The HKDF `info` label a future sprint will use to derive a per-message key from a chain
 * key. **Sprint 4 exposes this as an extension point only — it derives no message keys.**
 * @param {number} index @returns {Buffer}
 */
export function messageKeyLabel(index) {
  return label("message-key", `index=${index}`);
}

/** Securely zero-fill a key buffer. Idempotent. */
export function disposeKey(key) {
  if (Buffer.isBuffer(key)) key.fill(0);
}

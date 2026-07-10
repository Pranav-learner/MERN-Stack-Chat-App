/**
 * @module forward-secrecy/derivation
 *
 * The **generation-secret chain** — the one-way KDF ratchet that gives the engine its
 * forward secrecy. This is the ONLY new cryptographic primitive in Sprint 2, and it is
 * deliberately simple: a hash chain over HKDF-SHA256.
 *
 * ```
 * rootSecret ──HKDF("seed")──▶ chain₀ ──HKDF("evolve|1")──▶ chain₁ ──HKDF("evolve|2")──▶ chain₂ ...
 *                                │                              │
 *                          deriveKeys(chain₀)            deriveKeys(chain₁)
 *                                │                              │
 *                            keys(gen 0)                    keys(gen 1)
 * ```
 *
 * @security **One-wayness is the whole point.** Given `chainₙ₊₁` you cannot compute
 * `chainₙ` (HKDF/SHA-256 is preimage-resistant), so once `chainₙ` is destroyed, the
 * generation-`n` keys can never be re-derived — past traffic stays confidential even if
 * the current device state leaks. Both peers derive an identical chain independently from
 * the SAME Layer 4 shared secret (HKDF is deterministic), so **no key material is ever
 * transmitted** and the relay server still sees nothing.
 *
 * @forward-secrecy This is a *generation-level* chain, NOT a Double Ratchet and NOT a
 * per-message chain-key ladder. It advances once per session evolution.
 */

import crypto from "node:crypto";
import { deriveSessionKeys, disposeSessionKeys } from "../../shs/session/derivation/sessionKeys.js";
import { FS_NAMESPACE, FS_CHAIN_VERSION, CHAIN_SECRET_BYTES } from "../types/types.js";
import { ChainDerivationError } from "../errors.js";

/** HKDF-SHA256 into `length` bytes. */
function hkdf(secret, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, length));
}

/**
 * The per-session salt binding the chain to the session/handshake (domain separation).
 * @param {{ sessionId: string, handshakeId?: string }} context @returns {Buffer}
 */
export function chainSalt(context) {
  return Buffer.from(`${FS_NAMESPACE}-salt|v${FS_CHAIN_VERSION}|sid=${context.sessionId}|hs=${context.handshakeId ?? ""}`, "utf8");
}

/** The HKDF `info` label for a chain step. */
function chainInfo(kind, generation) {
  return Buffer.from(`${FS_NAMESPACE}|v${FS_CHAIN_VERSION}|${kind}|gen=${generation}`, "utf8");
}

/**
 * Seed the chain at generation 0 from a session's Layer 4 root secret (shared secret).
 * The seed is domain-separated from the Layer 4 session-key derivation so the FS chain is
 * cryptographically independent of the static Sprint 3 keys.
 *
 * @param {Buffer|Uint8Array} rootSecret the device-local Layer 4 shared secret
 * @param {{ sessionId: string, handshakeId?: string }} context
 * @returns {Buffer} `chainSecret₀` (32 bytes) — DEVICE-LOCAL; never serialize
 * @throws {ChainDerivationError}
 */
export function seedChain(rootSecret, context) {
  const secret = Buffer.isBuffer(rootSecret) ? rootSecret : Buffer.from(rootSecret ?? []);
  if (secret.length === 0) throw new ChainDerivationError("A non-empty root secret is required to seed the chain");
  try {
    return hkdf(secret, chainSalt(context), chainInfo("chain-seed", 0), CHAIN_SECRET_BYTES);
  } catch (error) {
    throw new ChainDerivationError("Failed to seed the forward-secrecy chain", { cause: error });
  }
}

/**
 * Advance the chain ONE generation: `chainₙ ▶ chainₙ₊₁`. One-way — the input `chainSecret`
 * cannot be recovered from the output.
 *
 * @param {Buffer} chainSecret `chainₙ` (the current chain secret)
 * @param {number} nextGeneration `n+1`
 * @param {{ sessionId: string, handshakeId?: string }} context
 * @returns {Buffer} `chainₙ₊₁` (32 bytes) — DEVICE-LOCAL; never serialize
 * @throws {ChainDerivationError}
 */
export function evolveChain(chainSecret, nextGeneration, context) {
  if (!Buffer.isBuffer(chainSecret) || chainSecret.length === 0) {
    throw new ChainDerivationError("A current chain secret is required to evolve");
  }
  try {
    return hkdf(chainSecret, chainSalt(context), chainInfo("chain-evolve", nextGeneration), CHAIN_SECRET_BYTES);
  } catch (error) {
    throw new ChainDerivationError("Failed to evolve the forward-secrecy chain", { cause: error });
  }
}

/**
 * Derive a full set of session keys for a generation from its chain secret. Reuses the
 * Layer 4 {@link module:shs/session/derivation} derivation so the evolved keys have the
 * exact shape the Secure Transport encryptor expects (`encryptionKey`, `macKey`, `keyId`,
 * `keyFingerprint`, …) and are byte-compatible with the browser.
 *
 * @param {Buffer} chainSecret `chainₙ`
 * @param {{ handshakeId: string, participants: string[], deviceIds?: object, protocolVersion?: string }} sessionContext
 * @param {number} generation
 * @returns {import("../../shs/session/derivation/sessionKeys.js").SessionKeys} DEVICE-LOCAL keys
 * @throws {ChainDerivationError}
 */
export function deriveGenerationKeys(chainSecret, sessionContext, generation) {
  if (!Buffer.isBuffer(chainSecret) || chainSecret.length === 0) {
    throw new ChainDerivationError("A chain secret is required to derive generation keys");
  }
  try {
    return deriveSessionKeys(chainSecret, sessionContext, { generation });
  } catch (error) {
    throw new ChainDerivationError("Failed to derive generation keys", { cause: error });
  }
}

/** Securely zero-fill a chain secret buffer. Idempotent. */
export function disposeChainSecret(chainSecret) {
  if (Buffer.isBuffer(chainSecret)) chainSecret.fill(0);
}

/** Re-export the Layer 4 key disposer for symmetry. */
export { disposeSessionKeys };

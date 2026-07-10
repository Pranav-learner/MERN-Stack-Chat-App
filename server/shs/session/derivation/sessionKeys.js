/**
 * @module shs/session/derivation
 *
 * Session key derivation. Transforms the Sprint 2 raw shared secret into a complete
 * set of session keys using **HKDF-SHA256** with **context separation** (keys are
 * bound to the participants/devices/handshake) and **purpose separation** (each key
 * uses a distinct HKDF `info` label, mirroring the Layer 2 SDK's
 * `{ namespace, context, purpose }` derivation).
 *
 * Derives:
 *   - an **encryption key** (for a future AEAD; not used to encrypt yet),
 *   - an **authentication (MAC) key**,
 *   - **initialization material** (IV/nonce base),
 *   - **ratchet material** (future Layer 5 root; reserved),
 *   - a **resumption key** (signs resume tokens),
 *   - a PUBLIC **key identifier** + **key fingerprint**.
 *
 * @security This module outputs SECRET key bytes. Callers MUST keep them in the
 * device-local {@link module:shs/session/storage} and MUST NOT serialize/persist/return
 * them. Two devices sharing the same Sprint 2 secret + same context derive the SAME
 * session keys independently (HKDF is deterministic). node's HKDF is byte-identical
 * to the browser's Web Crypto HKDF, so client and reference derivations agree.
 */

import crypto from "node:crypto";
import { KeyPurpose, SESSION_KEY_ALGORITHM, SESSION_MAC_ALGORITHM, SESSION_KDF, SESSION_KEY_BYTES } from "../types.js";
import { KeyDerivationError } from "../errors.js";

/** Derivation namespace (matches the Layer 2 SDK default). */
export const NAMESPACE = "securechat";
/** Version tag baked into every info label (bump to rotate the whole scheme). */
export const DERIVATION_VERSION = 1;

/**
 * Build the canonical context string for a session. Sorting the participants makes
 * the context symmetric so both peers derive identical keys.
 * @param {{ handshakeId: string, participants: string[], deviceIds?: object, protocolVersion?: string }} ctx
 * @returns {string}
 */
export function buildContext(ctx) {
  const participants = [...(ctx.participants ?? [])].map(String).sort().join(",");
  const devices = ctx.deviceIds
    ? [ctx.deviceIds.initiator, ctx.deviceIds.responder].filter(Boolean).map(String).sort().join(",")
    : "";
  return `hs=${ctx.handshakeId}|parties=${participants}|devices=${devices}|pv=${ctx.protocolVersion ?? "1.0"}`;
}

/**
 * Build an HKDF `info` label for a `(context, purpose, generation)`. Domain-separated
 * and version-tagged; identical construction on server (node) and client (Web Crypto).
 * @param {string} context @param {string} purpose @param {number} [generation=0]
 * @returns {Buffer}
 */
export function infoLabel(context, purpose, generation = 0) {
  return Buffer.from(`SHS-session-v${DERIVATION_VERSION}|ns=${NAMESPACE}|ctx=${context}|purpose=${purpose}|gen=${generation}`, "utf8");
}

/** HKDF-SHA256 into `length` bytes. */
function hkdf(secret, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, length));
}

/**
 * @typedef {object} SessionKeys DEVICE-LOCAL secret key material. NEVER serialized.
 * @property {Buffer} encryptionKey 32 bytes (for a future AEAD)
 * @property {Buffer} macKey 32 bytes
 * @property {Buffer} initMaterial 16 bytes (IV/nonce base)
 * @property {Buffer} ratchetMaterial 32 bytes (reserved for Layer 5)
 * @property {Buffer} resumptionKey 32 bytes (signs resume tokens)
 * @property {string} keyId PUBLIC 32-hex identifier
 * @property {string} keyFingerprint PUBLIC SHA-256 commitment of (enc||mac)
 * @property {number} generation @property {string} context
 * @property {{ algorithm: string, length: number }} encryptionMeta
 * @property {{ algorithm: string, length: number }} authenticationMeta
 */

/**
 * Derive the full set of session keys from a shared secret.
 *
 * @param {Buffer|Uint8Array} sharedSecret the Sprint 2 raw shared secret (32 bytes)
 * @param {{ handshakeId: string, participants: string[], deviceIds?: object, protocolVersion?: string }} context
 * @param {{ generation?: number }} [options]
 * @returns {SessionKeys}
 * @throws {KeyDerivationError}
 *
 * @example
 * ```js
 * const keys = deriveSessionKeys(sharedSecret, { handshakeId, participants: ["alice","bob"] });
 * keys.keyId;          // public identifier
 * keys.encryptionKey;  // 32-byte Buffer — keep device-local, never expose
 * ```
 */
export function deriveSessionKeys(sharedSecret, context, options = {}) {
  const secret = Buffer.isBuffer(sharedSecret) ? sharedSecret : Buffer.from(sharedSecret);
  if (secret.length === 0) throw new KeyDerivationError("Shared secret is empty");
  const generation = options.generation ?? 0;
  const ctxString = buildContext(context);
  const salt = Buffer.from(`SHS-session-salt|${context.handshakeId}`, "utf8");

  try {
    const encryptionKey = hkdf(secret, salt, infoLabel(ctxString, KeyPurpose.ENCRYPTION, generation), SESSION_KEY_BYTES);
    const macKey = hkdf(secret, salt, infoLabel(ctxString, KeyPurpose.AUTHENTICATION, generation), SESSION_KEY_BYTES);
    const initMaterial = hkdf(secret, salt, infoLabel(ctxString, KeyPurpose.INITIALIZATION, generation), 16);
    const ratchetMaterial = hkdf(secret, salt, infoLabel(ctxString, KeyPurpose.RATCHET, generation), SESSION_KEY_BYTES);
    const resumptionKey = hkdf(secret, salt, infoLabel(ctxString, KeyPurpose.RESUMPTION, generation), SESSION_KEY_BYTES);
    const keyIdBytes = hkdf(secret, salt, infoLabel(ctxString, KeyPurpose.KEY_ID, generation), 16);

    return {
      encryptionKey,
      macKey,
      initMaterial,
      ratchetMaterial,
      resumptionKey,
      keyId: keyIdBytes.toString("hex"),
      keyFingerprint: crypto.createHash("sha256").update(encryptionKey).update(macKey).digest("hex"),
      generation,
      context: ctxString,
      encryptionMeta: { algorithm: SESSION_KEY_ALGORITHM, length: SESSION_KEY_BYTES },
      authenticationMeta: { algorithm: SESSION_MAC_ALGORITHM, length: SESSION_KEY_BYTES },
    };
  } catch (error) {
    if (error instanceof KeyDerivationError) throw error;
    throw new KeyDerivationError("Failed to derive session keys", { cause: error });
  }
}

/** The KDF identifier recorded in session security metadata. */
export const KDF_NAME = SESSION_KDF;

/**
 * Securely dispose of a {@link SessionKeys} bundle by zero-filling every secret
 * buffer. Idempotent. Call on destroy / logout.
 * @param {SessionKeys} keys
 */
export function disposeSessionKeys(keys) {
  if (!keys) return;
  for (const field of ["encryptionKey", "macKey", "initMaterial", "ratchetMaterial", "resumptionKey"]) {
    if (Buffer.isBuffer(keys[field])) keys[field].fill(0);
  }
}

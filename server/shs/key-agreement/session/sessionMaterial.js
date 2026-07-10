/**
 * @module shs/key-agreement/session
 *
 * Secure **session material** — the device-local record of an established shared
 * secret. Created after {@link module:shs/key-agreement/derivation} succeeds and
 * bound to a handshake session.
 *
 * @security The `sharedSecret` field is DEVICE-LOCAL and SECRET. It is never
 * serialized to a DTO (see {@link module:shs/key-agreement/serialization}) and never
 * leaves the device / crosses the network. This sprint stores the raw shared secret
 * only — it does NOT derive or store encryption keys.
 */

import crypto from "node:crypto";
import { CRYPTO_PROTOCOL_VERSION, X25519_SHARED_SECRET_BYTES } from "../types.js";

/** Default lifetime of session material before it is considered stale (ms). */
export const DEFAULT_MATERIAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Build a session-material record around a derived shared secret.
 *
 * @param {object} params
 * @param {string} params.handshakeId
 * @param {Buffer} params.sharedSecret the raw derived secret (base64-encoded internally)
 * @param {string} params.fingerprint the secret's one-way commitment/fingerprint
 * @param {string} params.algorithm @param {string} [params.cryptoVersion]
 * @param {number} [params.ttlMs] @param {object} [params.metadata]
 * @param {boolean} [params.ephemeralDestroyed=true]
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types.js").SessionMaterial}
 */
export function createSessionMaterial(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const ttlMs = params.ttlMs ?? DEFAULT_MATERIAL_TTL_MS;

  return {
    sessionId: idGenerator(),
    handshakeId: String(params.handshakeId),
    // SECRET — never serialized to a DTO. Stored base64 for the local secure store.
    sharedSecret: Buffer.isBuffer(params.sharedSecret)
      ? params.sharedSecret.toString("base64")
      : String(params.sharedSecret),
    sharedSecretFingerprint: params.fingerprint,
    algorithm: params.algorithm,
    cryptoVersion: params.cryptoVersion ?? CRYPTO_PROTOCOL_VERSION,
    security: {
      keyLength: X25519_SHARED_SECRET_BYTES,
      kdf: "none-raw-ecdh", // Sprint 2 stores the raw ECDH secret; a KDF comes later
      ephemeralDestroyed: params.ephemeralDestroyed ?? true,
    },
    metadata: params.metadata ?? {},
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

/** Whether session material has passed its expiry. */
export function isMaterialExpired(material, now = Date.now()) {
  if (!material?.expiresAt) return false;
  return new Date(material.expiresAt).getTime() <= now;
}

/** The raw shared secret as a Buffer (device-local use only — e.g. a future KDF). */
export function materialSecretBytes(material) {
  return Buffer.from(material.sharedSecret, "base64");
}

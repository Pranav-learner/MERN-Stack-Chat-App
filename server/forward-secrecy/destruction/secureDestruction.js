/**
 * @module forward-secrecy/destruction
 *
 * **Secure key destruction.** After a successful evolution the previous generation's
 * secrets must not linger — forward secrecy depends on it. This module zero-fills secret
 * buffers and produces PUBLIC {@link DestructionRecord}s (metadata only) so the audit
 * trail can prove *that* material was destroyed without ever revealing *what*.
 *
 * @security JavaScript cannot force-wipe every copy of a value the way C can (the GC may
 * have moved bytes), but zero-filling the live `Buffer`s removes the primary copy and is
 * the strongest guarantee available on this runtime. Destruction records NEVER contain
 * key bytes — only key ids, fingerprints, generation numbers, and reasons.
 */

import { disposeSessionKeys, disposeChainSecret } from "../derivation/keyChain.js";
import { DestructionReason } from "../types/types.js";

/** Zero-fill any Buffer; ignore non-buffers. Idempotent. */
export function zeroize(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

/**
 * Build a PUBLIC destruction record. Throws if anything key-like is passed in `details`.
 * @param {object} params
 * @param {string} params.scope what was destroyed ("generation-keys" | "chain-secret" | "intermediate")
 * @param {number} [params.generation] @param {string} [params.keyId] @param {string} [params.fingerprint]
 * @param {string} [params.reason] one of {@link DestructionReason}
 * @param {string} [params.at] ISO timestamp
 * @returns {import("../types/types.js").DestructionRecord}
 */
export function buildDestructionRecord(params) {
  const record = {
    scope: params.scope,
    reason: params.reason ?? DestructionReason.SUPERSEDED,
    at: params.at ?? new Date().toISOString(),
  };
  if (params.generation !== undefined) record.generation = params.generation;
  if (params.keyId !== undefined) record.keyId = params.keyId;
  if (params.fingerprint !== undefined) record.fingerprint = params.fingerprint;
  return record;
}

/**
 * Securely destroy a generation's derived keys and return its destruction record. The
 * `keyId`/`fingerprint` are read BEFORE wiping (they are public and safe to keep).
 * @param {object} keys a device-local {@link SessionKeys} bundle (or null)
 * @param {{ generation: number, reason?: string, at?: string }} meta
 * @returns {import("../types/types.js").DestructionRecord}
 */
export function destroyGenerationKeys(keys, meta) {
  const keyId = keys?.keyId;
  const fingerprint = keys?.keyFingerprint;
  disposeSessionKeys(keys);
  return buildDestructionRecord({
    scope: "generation-keys",
    generation: meta.generation,
    keyId,
    fingerprint,
    reason: meta.reason ?? DestructionReason.SUPERSEDED,
    at: meta.at,
  });
}

/**
 * Securely destroy a chain secret and return its destruction record.
 * @param {Buffer} chainSecret @param {{ generation: number, reason?: string, at?: string }} meta
 * @returns {import("../types/types.js").DestructionRecord}
 */
export function destroyChainSecret(chainSecret, meta) {
  disposeChainSecret(chainSecret);
  return buildDestructionRecord({
    scope: "chain-secret",
    generation: meta.generation,
    reason: meta.reason ?? DestructionReason.SUPERSEDED,
    at: meta.at,
  });
}

/**
 * Destroy the intermediate material produced by a FAILED evolution (a half-derived next
 * chain secret and/or next keys), so a failed attempt leaves nothing exploitable behind.
 * @param {{ chainSecret?: Buffer, keys?: object, generation: number, at?: string }} material
 * @returns {import("../types/types.js").DestructionRecord}
 */
export function destroyIntermediateMaterial(material) {
  disposeChainSecret(material.chainSecret);
  disposeSessionKeys(material.keys);
  return buildDestructionRecord({
    scope: "intermediate",
    generation: material.generation,
    reason: DestructionReason.FAILED_EVOLUTION,
    at: material.at,
  });
}

export { DestructionReason };

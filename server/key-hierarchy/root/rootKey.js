/**
 * @module key-hierarchy/root
 *
 * The **Session Root Key** metadata model + lifecycle helpers. The root key is the top of
 * the hierarchy: it represents the session's root secret (for a given generation) and
 * generates the child chains. Its raw bytes live only in the device key store; this module
 * deals in PUBLIC metadata (`rootKeyId`, `fingerprint`, `generation`, `version`, `status`).
 *
 * @security The raw root key NEVER appears in this record. It is derived in
 * {@link module:key-hierarchy/derivation} and held in {@link module:key-hierarchy/keystore}.
 */

import { RootKeyStatus, INITIAL_GENERATION } from "../types/types.js";
import { keyFingerprint, keyId } from "../derivation/derivation.js";

/**
 * Build a PUBLIC root-key metadata record for a derived root key.
 * @param {Buffer} rootKey the derived root key (read for fingerprint/id; NOT stored)
 * @param {{ generation?: number, version?: number, at?: string }} [meta]
 * @returns {import("../types/types.js").RootKeyMeta}
 */
export function createRootKeyMeta(rootKey, meta = {}) {
  const generation = meta.generation ?? INITIAL_GENERATION;
  return {
    rootKeyId: keyId(rootKey, "root", generation),
    fingerprint: keyFingerprint(rootKey),
    generation,
    version: meta.version ?? 1,
    status: RootKeyStatus.ACTIVE,
    createdAt: meta.at ?? new Date().toISOString(),
  };
}

/** Whether a root-key status still holds live key material. */
export function isRootKeyLive(status) {
  return status === RootKeyStatus.ACTIVE;
}

/** Mark a root-key record superseded (a newer generation re-rooted the hierarchy). */
export function supersedeRootKey(rootMeta, at) {
  return { ...rootMeta, status: RootKeyStatus.SUPERSEDED, supersededAt: at ?? new Date().toISOString() };
}

export { RootKeyStatus };

/**
 * @module message-keys/destruction
 *
 * **Secure destruction of ephemeral message keys.** A message key is wiped immediately after
 * its single encrypt/decrypt (and on any failure). This module zero-fills the secret buffers
 * and produces a PUBLIC destruction record (metadata only).
 *
 * @security JavaScript cannot guarantee every byte copy is erased, but zero-filling the live
 * `Buffer`s removes the primary copy — the strongest guarantee this runtime offers. A
 * destruction record NEVER contains key bytes (only the public keyId/fingerprint + reason).
 */

import { MessageKeyState } from "../types/types.js";

/** Zero-fill a buffer. Idempotent. */
export function zeroize(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

/**
 * Securely destroy a message key bundle (zero-fills `encryptionKey` + `macKey`) and return a
 * PUBLIC destruction record. Reads the public keyId/fingerprint BEFORE wiping.
 * @param {import("../types/types.js").MessageKeyBundle} bundle
 * @param {{ reason?: string, at?: string }} [meta]
 * @returns {{ keyId: string, fingerprint: string, messageNumber: number, direction: string, generation: number, reason: string, at: string }}
 */
export function destroyMessageKey(bundle, meta = {}) {
  const record = {
    keyId: bundle?.keyId,
    fingerprint: bundle?.keyFingerprint,
    messageNumber: bundle?.messageNumber,
    direction: bundle?.direction,
    generation: bundle?.generation,
    reason: meta.reason ?? "used",
    at: meta.at ?? new Date().toISOString(),
  };
  if (bundle) {
    zeroize(bundle.encryptionKey);
    zeroize(bundle.macKey);
    bundle.state = MessageKeyState.DESTROYED;
  }
  return record;
}

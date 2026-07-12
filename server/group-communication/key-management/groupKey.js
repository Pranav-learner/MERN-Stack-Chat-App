/**
 * @module group-communication/key-management/groupKey
 *
 * The **device-local** cryptographic derivation for group keys — HKDF-SHA256, deterministic, and
 * byte-compatible with the Layer 5 key hierarchy + the browser's Web Crypto. This is the ONLY place raw
 * group-key bytes exist, and they NEVER leave the device: the engine + repositories store only the
 * PUBLIC fingerprint (a SHA-256 commitment) + version metadata.
 *
 * ## Model — a versioned group "epoch" key (sender-key style)
 * Each group has an **epoch secret** per key version. The epoch encryption key is derived from it:
 *
 * ```
 * epochSecret(v) ──HKDF("group-key|gid=G|v=V")──▶ Group Key (v)   [32 bytes, device-local]
 * ```
 *
 * ## Rotation semantics (forward secrecy)
 * - **Ratchet rotation** (`nextEpochSecret`): `epochSecret(v+1) = HKDF(epochSecret(v), "rotate")` — one-way,
 *   so a leaked LATER epoch secret cannot recover an earlier one. Used for benign rotations (scheduled /
 *   join) where members already trust the chain.
 * - **Fresh rotation** (`freshEpochSecret`): a brand-new random secret. REQUIRED when a member LEAVES /
 *   is REMOVED / on ownership transfer / compromise — the departed member holds `epochSecret(v)` and a
 *   ratchet would let them derive `epochSecret(v+1)`; fresh randomness does not.
 *
 * @security No function here persists or transmits a secret. `groupKeyFingerprint` is the public
 * commitment stored server-side; `deriveGroupKey` output is device-local and disposed after use.
 */

import crypto from "node:crypto";
import { GC_NAMESPACE, GC_VERSION, GC_KEY_BYTES } from "../types/types.js";

/** HKDF-SHA256 into `length` bytes (same primitive as the Layer 5 key hierarchy). */
function hkdf(secret, salt, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, length));
}

/** Per-group salt binding a key to its group (domain separation). */
export function groupKeySalt(groupId) {
  return Buffer.from(`${GC_NAMESPACE}-salt|v${GC_VERSION}|gid=${groupId}`, "utf8");
}

/** An HKDF `info` label. */
function label(kind, ...parts) {
  return Buffer.from(`${GC_NAMESPACE}|v${GC_VERSION}|${kind}${parts.length ? "|" + parts.join("|") : ""}`, "utf8");
}

/**
 * Generate a FRESH random epoch secret (device-local). Injectable RNG for deterministic tests.
 * @param {() => Buffer} [randomBytes] @returns {Buffer} 32 random bytes — DEVICE-LOCAL, never serialize
 */
export function freshEpochSecret(randomBytes) {
  return randomBytes ? Buffer.from(randomBytes(GC_KEY_BYTES)) : crypto.randomBytes(GC_KEY_BYTES);
}

/**
 * Ratchet an epoch secret forward one version (one-way). Used for benign rotations only.
 * @param {Buffer} epochSecret the current epoch secret @param {string} groupId @param {number} nextVersion
 * @returns {Buffer} the next epoch secret — DEVICE-LOCAL
 */
export function nextEpochSecret(epochSecret, groupId, nextVersion) {
  const secret = Buffer.isBuffer(epochSecret) ? epochSecret : Buffer.from(epochSecret ?? []);
  if (secret.length === 0) throw new Error("A non-empty epoch secret is required to ratchet");
  return hkdf(secret, groupKeySalt(groupId), label("rotate", `v=${nextVersion}`), GC_KEY_BYTES);
}

/**
 * Derive the group ENCRYPTION KEY for an epoch from its epoch secret. Deterministic: every member
 * derives an identical key from the same epoch secret, so the key itself is never transmitted.
 * @param {Buffer} epochSecret @param {{ groupId: string, keyVersion: number }} context
 * @returns {Buffer} the 32-byte group key — DEVICE-LOCAL
 */
export function deriveGroupKey(epochSecret, context) {
  const secret = Buffer.isBuffer(epochSecret) ? epochSecret : Buffer.from(epochSecret ?? []);
  if (secret.length === 0) throw new Error("A non-empty epoch secret is required to derive a group key");
  return hkdf(secret, groupKeySalt(context.groupId), label("group-key", `v=${context.keyVersion}`), GC_KEY_BYTES);
}

/**
 * The PUBLIC fingerprint of a group key (a SHA-256 commitment) — safe to store/serialize. Two devices
 * that derived the same epoch key produce the same fingerprint, which is how the engine verifies key
 * agreement WITHOUT ever seeing the key.
 * @param {Buffer} key @returns {string} hex
 */
export function groupKeyFingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** A stable, opaque key id for an epoch (public). */
export function groupKeyId(groupId, keyVersion, fingerprint) {
  return crypto.createHash("sha256").update(`${GC_NAMESPACE}|id|${groupId}|${keyVersion}`).update(fingerprint ?? "").digest("hex").slice(0, 32);
}

/** A stable hash of a member set (order-independent) — commits a key to the membership it was made for. */
export function memberSetHash(memberIds = []) {
  const sorted = [...new Set(memberIds.map(String))].sort();
  return crypto.createHash("sha256").update(`${GC_NAMESPACE}|members|${sorted.join(",")}`).digest("hex");
}

/** Securely dispose device-local key bytes (best-effort zeroization). */
export function disposeGroupKey(key) {
  if (Buffer.isBuffer(key)) key.fill(0);
  return null;
}

/**
 * Build a **device-local key provider** — the seam the engine calls to obtain the PUBLIC fingerprint of
 * a new epoch key WITHOUT the engine ever seeing the secret. It models a device's local secret store:
 * it holds each group's current epoch secret in a closure, ratchets or freshly-generates the next one,
 * derives the epoch key, and returns ONLY its fingerprint (disposing the key bytes immediately).
 *
 * In a SERVER deployment the client performs this derivation and posts the fingerprint; this default is
 * for device-embedded engines + tests. @param {{ randomBytes?: () => Buffer }} [opts]
 * @returns {(ctx: { groupId: string, keyVersion: number, fresh?: boolean }) => Promise<{ fingerprint: string }>}
 */
export function createLocalKeyProvider(opts = {}) {
  const secrets = new Map(); // groupId → epoch secret (DEVICE-LOCAL, never leaves this closure)
  return async ({ groupId, keyVersion, fresh }) => {
    const prev = secrets.get(String(groupId));
    const secret = fresh || !prev ? freshEpochSecret(opts.randomBytes) : nextEpochSecret(prev, groupId, keyVersion);
    secrets.set(String(groupId), secret);
    const key = deriveGroupKey(secret, { groupId, keyVersion });
    const fingerprint = groupKeyFingerprint(key);
    disposeGroupKey(key);
    return { fingerprint };
  };
}

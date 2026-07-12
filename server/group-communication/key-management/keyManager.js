/**
 * @module group-communication/key-management/keyManager
 *
 * The **Group Key Manager** — owns the group-key LIFECYCLE as metadata. It creates the initial epoch,
 * rotates to new epochs (bumping `keyVersion`), tracks per-member distribution, expires + revokes keys,
 * and records a key audit trail. It integrates with the Layer 5 key hierarchy by reusing its HKDF-SHA256
 * derivation primitives (see {@link module:group-communication/key-management/groupKey}) — it does NOT
 * redesign any cryptographic primitive.
 *
 * @security The manager stores group-key METADATA ONLY — version, epoch, opaque fingerprint (a SHA-256
 * commitment), member-set hash, distribution + expiry metadata, state. It NEVER stores or transmits the
 * key bytes; those are derived + held DEVICE-LOCAL. The `fingerprint` a caller supplies is the device's
 * public commitment to the key it derived, which lets the engine confirm key agreement blind.
 */

import {
  GroupKeyState,
  GROUP_KEY_TRANSITIONS,
  RekeyTrigger,
  ALL_REKEY_TRIGGERS,
  GC_KDF,
  DEFAULT_KEY_TTL_MS,
  GROUP_COMM_SCHEMA_VERSION,
} from "../types/types.js";
import { GroupKeyNotFoundError, InvalidGroupKeyError, ExpiredGroupKeyError, GroupCommValidationError } from "../errors.js";
import { memberSetHash } from "./groupKey.js";

/** Whether a group-key state transition is legal. */
export function canKeyTransition(from, to) {
  if (from === to) return true;
  return (GROUP_KEY_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a group-key state transition is legal. @throws {InvalidGroupKeyError} */
export function assertKeyTransition(from, to) {
  if (!canKeyTransition(from, to)) throw new InvalidGroupKeyError(`Cannot transition group key from "${from}" to "${to}"`, { details: { from, to } });
  return true;
}

export class GroupKeyManager {
  /**
   * @param {object} deps
   * @param {object} deps.keys the key store (`create · findActive · findByVersion · listByGroup · update`)
   * @param {object} [deps.keyAudit] the key-audit store (`record · listByGroup`)
   * @param {() => number} [deps.clock] @param {number} [deps.keyTtlMs]
   */
  constructor(deps = {}) {
    if (!deps.keys || typeof deps.keys.create !== "function") throw new GroupCommValidationError("GroupKeyManager requires a 'keys' store");
    this.keys = deps.keys;
    this.keyAudit = deps.keyAudit ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.keyTtlMs = deps.keyTtlMs ?? DEFAULT_KEY_TTL_MS;
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }

  /**
   * Create the INITIAL group key (version 1). @param {object} params
   * @param {string} params.groupId @param {string} params.createdBy @param {string} params.fingerprint
   * device commitment @param {string[]} params.memberIds @param {number} [params.ttlMs] @param {string} [params.trigger]
   * @returns {Promise<import("../types/types.js").GroupKeyMeta>}
   */
  async createInitialKey(params) {
    if (await this.keys.findActive(params.groupId)) throw new InvalidGroupKeyError("Group already has an active key", { details: { groupId: params.groupId } });
    return this._create({ ...params, keyVersion: 1, trigger: params.trigger ?? RekeyTrigger.MANUAL });
  }

  /**
   * Rotate to a NEW key version (rekey). Supersedes the current active key. @param {object} params
   * @param {string} params.groupId @param {string} params.createdBy @param {string} params.fingerprint
   * @param {string[]} params.memberIds @param {string} params.trigger one of {@link RekeyTrigger}
   * @param {number} [params.ttlMs] @returns {Promise<import("../types/types.js").GroupKeyMeta>}
   */
  async rotateKey(params) {
    if (!ALL_REKEY_TRIGGERS.includes(params.trigger)) throw new GroupCommValidationError(`Unknown rekey trigger "${params.trigger}"`, { details: { trigger: params.trigger } });
    const current = await this.keys.findActive(params.groupId);
    const nextVersion = (current?.keyVersion ?? 0) + 1;
    const created = await this._create({ ...params, keyVersion: nextVersion });
    if (current) {
      assertKeyTransition(current.state, GroupKeyState.SUPERSEDED);
      await this.keys.update(params.groupId, current.keyVersion, { state: GroupKeyState.SUPERSEDED, supersededBy: nextVersion, supersededAt: this._nowIso() });
      await this._audit({ groupId: params.groupId, keyVersion: current.keyVersion, action: "superseded", trigger: params.trigger });
    }
    return created;
  }

  /** @private create + persist a key-version metadata record + audit. */
  async _create({ groupId, keyVersion, fingerprint, createdBy, memberIds = [], trigger, ttlMs }) {
    if (typeof fingerprint !== "string" || fingerprint.length < 16) throw new InvalidGroupKeyError("A valid key fingerprint (device commitment) is required", { details: { groupId } });
    const now = this._nowIso();
    const ttl = ttlMs ?? this.keyTtlMs;
    const record = {
      groupId: String(groupId),
      keyVersion,
      fingerprint,
      keyId: `${groupId}:${keyVersion}`,
      algorithm: GC_KDF,
      state: GroupKeyState.ACTIVE,
      trigger,
      createdBy: String(createdBy),
      createdAt: now,
      expiresAt: ttl && ttl > 0 ? new Date(this.clock() + ttl).toISOString() : null,
      memberSetHash: memberSetHash(memberIds),
      distribution: [...new Set(memberIds.map(String))].map((memberId) => ({ memberId, delivered: false, deliveredAt: null })),
      supersededBy: null,
      schemaVersion: GROUP_COMM_SCHEMA_VERSION,
    };
    const stored = await this.keys.create(record);
    await this._audit({ groupId: record.groupId, keyVersion, action: "created", trigger });
    return stored;
  }

  /** The active key for a group (or throws). @returns {Promise<import("../types/types.js").GroupKeyMeta>} */
  async requireActiveKey(groupId) {
    const key = await this.keys.findActive(groupId);
    if (!key) throw new GroupKeyNotFoundError("No active group key", { details: { groupId } });
    this.assertUsable(key);
    return key;
  }

  /** The active key for a group, or null. */
  async getActiveKey(groupId) {
    return this.keys.findActive(groupId);
  }

  /** A specific key version (or throws). */
  async requireKeyVersion(groupId, keyVersion) {
    const key = await this.keys.findByVersion(groupId, keyVersion);
    if (!key) throw new GroupKeyNotFoundError("Group key version not found", { details: { groupId, keyVersion } });
    return key;
  }

  /** All key versions for a group (newest first). */
  async listKeys(groupId) {
    return this.keys.listByGroup(groupId);
  }

  /** Assert a key is usable (active or superseded, not expired/revoked). @throws */
  assertUsable(key) {
    if (!key) throw new GroupKeyNotFoundError("Group key not found");
    if (key.state === GroupKeyState.REVOKED) throw new InvalidGroupKeyError("Group key is revoked", { details: { keyVersion: key.keyVersion } });
    if (key.state === GroupKeyState.EXPIRED) throw new ExpiredGroupKeyError("Group key has expired", { details: { keyVersion: key.keyVersion } });
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= this.clock()) throw new ExpiredGroupKeyError("Group key has expired", { details: { keyVersion: key.keyVersion, expiresAt: key.expiresAt } });
    return true;
  }

  /** Record that a member received a key version (distribution metadata). */
  async markDistributed(groupId, keyVersion, memberId) {
    const key = await this.requireKeyVersion(groupId, keyVersion);
    const distribution = (key.distribution ?? []).map((d) => (d.memberId === String(memberId) ? { ...d, delivered: true, deliveredAt: this._nowIso() } : d));
    if (!distribution.some((d) => d.memberId === String(memberId))) distribution.push({ memberId: String(memberId), delivered: true, deliveredAt: this._nowIso() });
    return this.keys.update(groupId, keyVersion, { distribution });
  }

  /** Members who have NOT yet received a key version (for rekey catch-up). */
  async pendingDistribution(groupId, keyVersion) {
    const key = await this.requireKeyVersion(groupId, keyVersion);
    return (key.distribution ?? []).filter((d) => !d.delivered).map((d) => d.memberId);
  }

  /** Expire a key version (sweep or explicit). Emits nothing here — the engine emits. */
  async expireKey(groupId, keyVersion) {
    const key = await this.requireKeyVersion(groupId, keyVersion);
    assertKeyTransition(key.state, GroupKeyState.EXPIRED);
    const updated = await this.keys.update(groupId, keyVersion, { state: GroupKeyState.EXPIRED, expiredAt: this._nowIso() });
    await this._audit({ groupId, keyVersion, action: "expired" });
    return updated;
  }

  /** Revoke a key version (compromise). */
  async revokeKey(groupId, keyVersion, reason = "compromise") {
    const key = await this.requireKeyVersion(groupId, keyVersion);
    assertKeyTransition(key.state, GroupKeyState.REVOKED);
    const updated = await this.keys.update(groupId, keyVersion, { state: GroupKeyState.REVOKED, revokedAt: this._nowIso(), revokeReason: reason });
    await this._audit({ groupId, keyVersion, action: "revoked", trigger: reason });
    return updated;
  }

  /** Sweep expired keys for a group; returns the versions expired. */
  async sweepExpired(groupId) {
    const keys = await this.keys.listByGroup(groupId);
    const expired = [];
    for (const key of keys) {
      if (key.state !== GroupKeyState.EXPIRED && key.state !== GroupKeyState.REVOKED && key.expiresAt && new Date(key.expiresAt).getTime() <= this.clock()) {
        await this.keys.update(groupId, key.keyVersion, { state: GroupKeyState.EXPIRED, expiredAt: this._nowIso() });
        await this._audit({ groupId, keyVersion: key.keyVersion, action: "expired" });
        expired.push(key.keyVersion);
      }
    }
    return expired;
  }

  /** Key audit trail. */
  async getKeyAudit(groupId, options = {}) {
    return (await this.keyAudit?.listByGroup?.(groupId, options)) ?? [];
  }

  async _audit(entry) {
    return this.keyAudit?.record?.({ ...entry, at: this._nowIso() });
  }
}

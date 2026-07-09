/**
 * @module trust/manager
 *
 * The Trust Manager — the reusable facade for user-to-user identity verification
 * and trust establishment. It manages fingerprints, safety numbers, QR payloads,
 * verification records, and identity-change detection, emitting trust events for
 * future layers (Secure Handshake in Layer 4).
 *
 * It contains NO handshake, session, encryption, or P2P logic. It operates on
 * PUBLIC identity material only; no private keys are ever accessed or stored.
 *
 * @security All values here (fingerprints, safety numbers, QR payloads) derive
 * from PUBLIC keys. Verification asserts "I compared out-of-band and it matched";
 * it is not a cryptographic handshake and does not prove key possession.
 */

import crypto from "node:crypto";
import { TrustState, TrustEventType, TrustWarningType, VerificationMethod } from "../types.js";
import {
  SafetyNumberMismatchError,
  FingerprintMismatchError,
  UnknownIdentityError,
  VerificationNotFoundError,
} from "../errors.js";
import { decodePublicKey } from "../../identity/validators/identityValidators.js";
import { buildFingerprint } from "../fingerprints/fingerprint.js";
import { computeSafetyNumber, normalizeSafetyNumber } from "../safety-number/safetyNumber.js";
import { buildQrPayload, serializeQrPayload, deserializeQrPayload } from "../qr/qrPayload.js";
import { assertTransition, validateVerifyRequest } from "../validators/trustValidators.js";
import { toPublicVerification, toPublicChange } from "../serialization/trustSerializer.js";
import { TrustEventBus } from "../events/trustEvents.js";

const VERIFIED_LIKE = [TrustState.VERIFIED, TrustState.TRUSTED];

/**
 * @typedef {object} TrustManagerDeps
 * @property {object} verifications verification repository
 * @property {object} changes identity-change repository
 * @property {(userId: string) => Promise<{userId:string, identityId:string, publicKey:string, algorithm:string}|null>} identityLookup
 *   resolves a user's CURRENT public identity (e.g. Sprint 1 IdentityManager)
 * @property {(userId: string) => Promise<string[]>} [deviceLookup] resolves a user's current device fingerprints
 * @property {TrustEventBus} [events]
 * @property {() => number} [clock]
 * @property {() => string} [idGenerator]
 * @property {{version?:number, iterations?:number}} [safetyNumberOptions]
 * @property {number|null} [verificationTtlMs] freshness window (default null = never expires)
 */

/**
 * Manages identity verification and trust between users.
 *
 * @example
 * ```js
 * const trust = new TrustManager({
 *   verifications, changes,
 *   identityLookup: (id) => identityManager.getIdentityByUser(id),
 * });
 * const sn = await trust.getSafetyNumber("alice", "bob"); // same for both
 * await trust.verifyIdentity("alice", "bob", { expectedSafetyNumber: sn.safetyNumber });
 * ```
 */
export class TrustManager {
  /** @param {TrustManagerDeps} deps */
  constructor(deps) {
    if (!deps || !deps.verifications || !deps.changes || typeof deps.identityLookup !== "function") {
      throw new Error("TrustManager requires { verifications, changes, identityLookup }");
    }
    this.verifications = deps.verifications;
    this.changes = deps.changes;
    this.identityLookup = deps.identityLookup;
    this.deviceLookup = deps.deviceLookup ?? null;
    this.events = deps.events ?? new TrustEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.safetyNumberOptions = deps.safetyNumberOptions ?? {};
    this.verificationTtlMs = deps.verificationTtlMs ?? null;
  }

  // === fingerprints & safety numbers ======================================

  /** Rich fingerprint of a user's identity. @throws {UnknownIdentityError} */
  async getFingerprint(userId) {
    return (await this._requireIdentity(userId)).fingerprint;
  }

  /**
   * The symmetric pairwise safety number between two users (identical for both).
   * @returns {Promise<{ version: number, safetyNumber: string, formatted: string }>}
   */
  async getSafetyNumber(verifierUser, subjectUser) {
    const a = await this._requireIdentity(verifierUser);
    const b = await this._requireIdentity(subjectUser);
    const sn = this._safetyNumber(a, b);
    this.events.emit(TrustEventType.SAFETY_NUMBER_GENERATED, { verifierUser, subjectUser });
    return { version: sn.version, safetyNumber: sn.value, formatted: sn.formatted };
  }

  // === verification lifecycle =============================================

  /** Start a verification (PENDING) without confirming yet. */
  async initiateVerification(verifierUser, subjectUser) {
    validateVerifyRequest({ verifierUser, subjectUser });
    const subject = await this._requireIdentity(subjectUser);
    const verifier = await this._requireIdentity(verifierUser);
    const record = await this._upsert(verifierUser, subject, {
      trustState: TrustState.PENDING,
      method: VerificationMethod.MANUAL,
      safetyNumber: this._safetyNumber(verifier, subject).value,
      historyEvent: "initiated",
    });
    return toPublicVerification(record, { effectiveState: record.trustState });
  }

  /**
   * Confirm a verification. If `expectedSafetyNumber`/`expectedFingerprint` are
   * supplied they must match the computed/current values (out-of-band comparison).
   * @param {string} verifierUser @param {string} subjectUser
   * @param {{ method?: string, expectedSafetyNumber?: string, expectedFingerprint?: string }} [options]
   * @throws {SafetyNumberMismatchError | FingerprintMismatchError | UnknownIdentityError}
   */
  async verifyIdentity(verifierUser, subjectUser, options = {}) {
    validateVerifyRequest({ verifierUser, subjectUser });
    const verifier = await this._requireIdentity(verifierUser);
    const subject = await this._requireIdentity(subjectUser);
    const sn = this._safetyNumber(verifier, subject);

    if (options.expectedSafetyNumber !== undefined &&
        normalizeSafetyNumber(options.expectedSafetyNumber) !== sn.value) {
      this.events.emit(TrustEventType.IDENTITY_CHANGED, {
        verifierUser, subjectUser, details: { warning: TrustWarningType.SAFETY_NUMBER_MISMATCH },
      });
      throw new SafetyNumberMismatchError();
    }
    if (options.expectedFingerprint !== undefined &&
        options.expectedFingerprint.toLowerCase() !== subject.fingerprint.machine) {
      throw new FingerprintMismatchError();
    }

    const record = await this._upsert(verifierUser, subject, {
      trustState: TrustState.VERIFIED,
      method: options.method ?? VerificationMethod.SAFETY_NUMBER,
      safetyNumber: sn.value,
      verifiedDeviceFingerprints: await this._deviceFingerprints(subjectUser),
      setVerifiedAt: true,
      historyEvent: "verified",
    });
    this.events.emit(TrustEventType.IDENTITY_VERIFIED, { verifierUser, subjectUser });
    this.events.emit(TrustEventType.TRUST_UPDATED, { verifierUser, subjectUser, details: { state: TrustState.VERIFIED } });
    return toPublicVerification(record, { effectiveState: record.trustState });
  }

  /** Elevate a verified relationship to TRUSTED. */
  async trustIdentity(verifierUser, subjectUser) {
    return this._transition(verifierUser, subjectUser, TrustState.TRUSTED);
  }

  /** Revoke a verification (UNTRUST). */
  async untrustIdentity(verifierUser, subjectUser) {
    const dto = await this._transition(verifierUser, subjectUser, TrustState.REVOKED);
    this.events.emit(TrustEventType.VERIFICATION_REVOKED, { verifierUser, subjectUser });
    return dto;
  }

  /** Mark a verification as blocked. */
  block(verifierUser, subjectUser) {
    return this._transition(verifierUser, subjectUser, TrustState.BLOCKED);
  }

  /** Mark a verification as compromised. */
  markCompromised(verifierUser, subjectUser) {
    return this._transition(verifierUser, subjectUser, TrustState.COMPROMISED);
  }

  // === status & change detection ==========================================

  /**
   * Verification status for a pair, running identity-change detection (persisting
   * a transition to CHANGED and logging/emitting if the subject's key changed).
   * @returns {Promise<{ state: string, verification: object|null, warnings: object[] }>}
   */
  async getVerificationStatus(verifierUser, subjectUser) {
    const record = await this.verifications.findByPair(verifierUser, subjectUser);
    const subject = await this._loadIdentity(subjectUser);
    if (!record) {
      const warnings = subject ? [] : [this._warning(TrustWarningType.UNKNOWN_IDENTITY, subjectUser, "no identity")];
      return { state: TrustState.UNKNOWN, verification: null, warnings };
    }
    const detection = await this._detect(record, subject, subjectUser);
    let current = record;
    let effective = record.trustState;

    if (detection.changed && VERIFIED_LIKE.includes(record.trustState)) {
      const now = this._nowIso();
      current = await this.verifications.update(record.verificationId, {
        trustState: TrustState.CHANGED,
        lastCheckedAt: now,
        history: [
          ...(record.history ?? []),
          { event: "identity-changed", at: now, fromFingerprint: record.verifiedFingerprint, toFingerprint: detection.currentFingerprint },
        ],
      });
      await this._logChange(record, subject, verifierUser, detection.currentFingerprint);
      this.events.emit(TrustEventType.FINGERPRINT_CHANGED, { verifierUser, subjectUser });
      this.events.emit(TrustEventType.IDENTITY_CHANGED, { verifierUser, subjectUser });
      effective = TrustState.CHANGED;
    } else if (VERIFIED_LIKE.includes(record.trustState) && this._isExpired(record)) {
      effective = TrustState.EXPIRED;
    }

    return {
      state: effective,
      verification: toPublicVerification(current, { effectiveState: effective, warnings: detection.warnings }),
      warnings: detection.warnings,
    };
  }

  /** List the caller's verifications (stored state; no per-item detection). */
  async listVerifications(verifierUser) {
    const records = await this.verifications.findByVerifier(verifierUser);
    return records.map((r) => toPublicVerification(r, { effectiveState: r.trustState }));
  }

  /**
   * Return the caller's verifications that currently carry warnings / detected
   * changes (runs detection across each).
   */
  async getChanges(verifierUser) {
    const records = await this.verifications.findByVerifier(verifierUser);
    const out = [];
    for (const record of records) {
      const subject = await this._loadIdentity(String(record.subjectUser));
      const detection = await this._detect(record, subject, String(record.subjectUser));
      if (detection.warnings.length > 0) {
        out.push({ subjectUserId: String(record.subjectUser), warnings: detection.warnings, trustState: record.trustState });
      }
    }
    return out;
  }

  /** Identity-change history for a subject. */
  async getIdentityHistory(subjectUser) {
    return (await this.changes.findBySubject(subjectUser)).map(toPublicChange);
  }

  // === QR verification ====================================================

  /** Build + serialize a QR verification payload for a subject's identity. */
  async generateQrPayload(subjectUser) {
    const subject = await this._requireIdentity(subjectUser);
    const payload = buildQrPayload({
      subjectUserId: subject.userId,
      identityId: subject.identityId,
      publicKey: subject.publicKey,
      algorithm: subject.algorithm,
      fingerprint: subject.fingerprint.machine,
      issuedAt: this._nowIso(),
    });
    const serialized = serializeQrPayload(payload);
    this.events.emit(TrustEventType.QR_PAYLOAD_GENERATED, { subjectUser });
    return { payload, serialized };
  }

  /** Validate a scanned QR payload string (throws on tamper). */
  validateQrPayload(serialized) {
    return deserializeQrPayload(serialized);
  }

  /**
   * Verify a subject by a scanned QR payload. Confirms the payload matches the
   * subject's CURRENT identity, then records a QR verification.
   * @throws {InvalidQrPayloadError | FingerprintMismatchError | UnknownIdentityError}
   */
  async verifyViaQr(verifierUser, serialized) {
    const payload = deserializeQrPayload(serialized);
    const subjectUser = payload.subjectUserId;
    validateVerifyRequest({ verifierUser, subjectUser });
    const subject = await this._requireIdentity(subjectUser);
    if (payload.publicKey !== subject.publicKey) {
      // The scanned identity no longer matches the current one (rotated/replaced).
      throw new FingerprintMismatchError("Scanned identity does not match the subject's current identity");
    }
    return this.verifyIdentity(verifierUser, subjectUser, { method: VerificationMethod.QR });
  }

  // === internals ==========================================================

  /** @private Resolve a user's current identity + derived fingerprint, or null. */
  async _loadIdentity(userId) {
    const id = await this.identityLookup(userId);
    if (!id || !id.publicKey) return null;
    const bytes = decodePublicKey(id.publicKey);
    return {
      userId: String(userId),
      identityId: id.identityId,
      publicKey: id.publicKey,
      algorithm: id.algorithm ?? "ed25519",
      bytes,
      fingerprint: buildFingerprint(bytes, { algorithm: id.algorithm ?? "ed25519" }),
    };
  }

  /** @private @throws {UnknownIdentityError} */
  async _requireIdentity(userId) {
    const id = await this._loadIdentity(userId);
    if (!id) throw new UnknownIdentityError("Identity not found", { details: { userId: String(userId) } });
    return id;
  }

  /** @private */
  _safetyNumber(a, b) {
    return computeSafetyNumber(
      { publicKey: a.bytes, identifier: a.userId },
      { publicKey: b.bytes, identifier: b.userId },
      this.safetyNumberOptions,
    );
  }

  /** @private Create or update the verification record for a pair. */
  async _upsert(verifierUser, subject, fields) {
    const now = this._nowIso();
    const existing = await this.verifications.findByPair(verifierUser, subject.userId);
    const historyEntry = { event: fields.historyEvent, at: now, toFingerprint: subject.fingerprint.machine };
    if (existing) {
      const patch = {
        trustState: fields.trustState,
        method: fields.method ?? existing.method,
        verifiedPublicKey: subject.publicKey,
        verifiedFingerprint: subject.fingerprint.machine,
        safetyNumber: fields.safetyNumber,
        lastCheckedAt: now,
        history: [...(existing.history ?? []), historyEntry],
      };
      if (fields.setVerifiedAt) patch.verifiedAt = now;
      if (fields.verifiedDeviceFingerprints) patch.verifiedDeviceFingerprints = fields.verifiedDeviceFingerprints;
      return this.verifications.update(existing.verificationId, patch);
    }
    return this.verifications.create({
      verificationId: this.idGenerator(),
      verifierUser,
      subjectUser: subject.userId,
      subjectIdentityId: subject.identityId,
      verifiedPublicKey: subject.publicKey,
      verifiedFingerprint: subject.fingerprint.machine,
      safetyNumber: fields.safetyNumber,
      trustState: fields.trustState,
      method: fields.method ?? VerificationMethod.MANUAL,
      verifiedDeviceFingerprints: fields.verifiedDeviceFingerprints ?? [],
      verifiedAt: fields.setVerifiedAt ? now : undefined,
      lastCheckedAt: now,
      history: [historyEntry],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  /** @private A guarded trust-state transition on an existing record. */
  async _transition(verifierUser, subjectUser, target) {
    const record = await this.verifications.findByPair(verifierUser, subjectUser);
    if (!record) throw new VerificationNotFoundError("No verification to update", { details: { subjectUser: String(subjectUser) } });
    assertTransition(record.trustState, target);
    const now = this._nowIso();
    const updated = await this.verifications.update(record.verificationId, {
      trustState: target,
      lastCheckedAt: now,
      history: [...(record.history ?? []), { event: `state:${target}`, at: now }],
    });
    this.events.emit(TrustEventType.TRUST_UPDATED, { verifierUser, subjectUser, details: { state: target } });
    return toPublicVerification(updated, { effectiveState: target });
  }

  /** @private Detect identity/fingerprint/device changes vs a verification record. */
  async _detect(record, subject, subjectUser) {
    const warnings = [];
    if (!subject) {
      warnings.push(this._warning(TrustWarningType.UNKNOWN_IDENTITY, subjectUser, "identity no longer exists"));
      return { changed: false, warnings, currentFingerprint: null };
    }
    const currentFingerprint = subject.fingerprint.machine;
    let changed = false;
    if (currentFingerprint !== record.verifiedFingerprint) {
      changed = true;
      warnings.push(this._warning(TrustWarningType.FINGERPRINT_CHANGED, subjectUser, "fingerprint changed", "high"));
      warnings.push(this._warning(TrustWarningType.IDENTITY_CHANGED, subjectUser, "identity key changed", "high"));
    }
    if (this.deviceLookup) {
      const current = await this.deviceLookup(subjectUser);
      const known = new Set(record.verifiedDeviceFingerprints ?? []);
      const added = (current ?? []).filter((f) => !known.has(f));
      if (added.length > 0) {
        warnings.push(this._warning(TrustWarningType.DEVICE_ADDED, subjectUser, `${added.length} new device(s)`, "medium"));
      }
    }
    return { changed, warnings, currentFingerprint };
  }

  /** @private */
  async _logChange(record, subject, verifierUser, toFingerprint) {
    await this.changes.create({
      subjectUser: record.subjectUser,
      identityId: record.subjectIdentityId,
      fromFingerprint: record.verifiedFingerprint,
      toFingerprint,
      fromPublicKey: record.verifiedPublicKey,
      toPublicKey: subject?.publicKey,
      detectedByUser: verifierUser,
      detectedAt: this._nowIso(),
    });
  }

  /** @private */
  async _deviceFingerprints(userId) {
    if (!this.deviceLookup) return [];
    return (await this.deviceLookup(userId)) ?? [];
  }

  /** @private */
  _isExpired(record) {
    if (!this.verificationTtlMs || !record.verifiedAt) return false;
    return this.clock() - new Date(record.verifiedAt).getTime() >= this.verificationTtlMs;
  }

  /** @private */
  _warning(type, subjectUser, message, severity = "info") {
    return { type, severity, subjectUserId: String(subjectUser), message };
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

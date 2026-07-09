/**
 * @module integration/identityContextService
 *
 * Layer 3 · Sprint 4 — the integration layer that composes the Identity (Sprint 1),
 * Device Trust (Sprint 2), and Trust/Verification (Sprint 3) subsystems into a
 * single consolidated **identity context** for authentication, WebSocket, and API
 * consumers.
 *
 * It performs NO cryptography and NO chat/handshake/encryption logic — it reads
 * from the three managers and assembles a public, cacheable view:
 *
 *   Load Identity → Load Devices → Load Trust → Ready
 *
 * @security Public data only. Never returns private keys. `ready`/`sessionValid`
 * reflect whether the user is provisioned and the current device is usable.
 */

/** Device trust states that make a session usable. */
const USABLE_DEVICE_STATES = new Set(["trusted", "pending", "inactive", "expired"]);
/** Device trust states that invalidate a session. */
const BLOCKING_DEVICE_STATES = new Set(["revoked", "blocked"]);
/** Verification states counted as "verified-like". */
const VERIFIED_LIKE = new Set(["verified", "trusted"]);

/** Tiny in-memory TTL cache (per-user base context) for performance. */
class TtlCache {
  constructor(ttlMs, clock) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && this.clock() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key, value) {
    this.map.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }
  delete(key) {
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

/**
 * Composes identity + device + trust into a consolidated context.
 *
 * @example
 * ```js
 * const service = new IdentityContextService({ identityManager, deviceManager, trustManager });
 * const ctx = await service.loadContext(userId, { deviceId });
 * if (!ctx.ready) { // prompt the client to provision / re-auth }
 * ```
 */
export class IdentityContextService {
  /**
   * @param {{ identityManager: object, deviceManager: object, trustManager: object,
   *           clock?: () => number, cacheTtlMs?: number }} deps
   */
  constructor(deps) {
    if (!deps?.identityManager || !deps?.deviceManager || !deps?.trustManager) {
      throw new Error("IdentityContextService requires { identityManager, deviceManager, trustManager }");
    }
    this.identityManager = deps.identityManager;
    this.deviceManager = deps.deviceManager;
    this.trustManager = deps.trustManager;
    this.clock = deps.clock ?? (() => Date.now());
    this.cache = new TtlCache(deps.cacheTtlMs ?? 5000, this.clock);
  }

  /**
   * Consolidated identity context for a user (+ optional current device).
   *
   * @param {string} userId
   * @param {{ deviceId?: string }} [options]
   * @returns {Promise<object>} the identity context (see module docs)
   */
  async loadContext(userId, options = {}) {
    const base = await this._loadBase(userId);
    const deviceId = options.deviceId ?? null;
    const currentDevice = deviceId ? (base.devices.find((d) => d.deviceId === deviceId) ?? null) : null;
    const sessionValid = this._isSessionValid(base, deviceId, currentDevice);
    const ready = base.provisioned && sessionValid;

    const warnings = [];
    if (!base.provisioned) {
      warnings.push({ type: "not-provisioned", severity: "info", message: "Identity not yet established for this user" });
    }
    if (deviceId && !currentDevice) {
      warnings.push({ type: "unknown-device", severity: "warn", message: "This device is not registered" });
    }
    if (currentDevice && BLOCKING_DEVICE_STATES.has(currentDevice.effectiveTrustStatus)) {
      warnings.push({ type: "device-untrusted", severity: "high", message: `Current device is ${currentDevice.effectiveTrustStatus}` });
    }

    return {
      userId: String(userId),
      provisioned: base.provisioned,
      identity: base.identity
        ? {
            identityId: base.identity.identityId,
            algorithm: base.identity.algorithm,
            publicKey: base.identity.publicKey,
            fingerprint: base.identity.fingerprint,
            status: base.identity.status,
          }
        : null,
      devices: base.devices,
      deviceCount: base.devices.length,
      currentDevice,
      verification: base.verification,
      sessionValid,
      ready,
      warnings,
    };
  }

  /**
   * Whether a (userId, deviceId) session is currently valid.
   * @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async validateSession(userId, deviceId) {
    const base = await this._loadBase(userId);
    if (!base.provisioned) return { valid: false, reason: "no-identity" };
    if (!deviceId) return { valid: true };
    const device = base.devices.find((d) => d.deviceId === deviceId);
    if (!device) return { valid: false, reason: "unknown-device" };
    if (BLOCKING_DEVICE_STATES.has(device.trustStatus)) return { valid: false, reason: `device-${device.trustStatus}` };
    return { valid: true };
  }

  /**
   * A compact per-user verification directory: the caller's verification state for
   * each subject they've verified (for badging contacts on the client). Fast — no
   * per-subject identity queries or change detection.
   * @param {string} userId
   * @returns {Promise<Array<{ subjectUserId: string, trustState: string, verifiedFingerprint: string }>>}
   */
  async verificationDirectory(userId) {
    const verifications = await this.trustManager.listVerifications(userId);
    return verifications.map((v) => ({
      subjectUserId: v.subjectUserId,
      trustState: v.effectiveTrustState,
      verifiedFingerprint: v.verifiedFingerprint,
    }));
  }

  /** Bust the cached base context for a user (e.g. after device/identity changes). */
  invalidate(userId) {
    this.cache.delete(String(userId));
  }

  // === internals ===========================================================

  /** @private Load + cache the base context (identity + devices + verification summary). */
  async _loadBase(userId) {
    const key = String(userId);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const [identity, devices, verifications] = await Promise.all([
      this.identityManager.getIdentityByUser(userId),
      this.deviceManager.listDevices(userId),
      this.trustManager.listVerifications(userId),
    ]);

    const base = {
      identity,
      devices,
      provisioned: !!identity,
      verification: this._summarize(verifications),
    };
    this.cache.set(key, base);
    return base;
  }

  /** @private */
  _summarize(verifications) {
    let verified = 0;
    let trusted = 0;
    for (const v of verifications) {
      if (v.effectiveTrustState === "trusted") trusted++;
      if (VERIFIED_LIKE.has(v.effectiveTrustState)) verified++;
    }
    return { total: verifications.length, verified, trusted };
  }

  /** @private */
  _isSessionValid(base, deviceId, currentDevice) {
    if (!base.provisioned) return false;
    if (!deviceId) return true;
    if (!currentDevice) return false;
    return (
      USABLE_DEVICE_STATES.has(currentDevice.effectiveTrustStatus) &&
      !BLOCKING_DEVICE_STATES.has(currentDevice.trustStatus)
    );
  }
}

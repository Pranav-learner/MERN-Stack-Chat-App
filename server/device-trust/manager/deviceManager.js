/**
 * @module device-trust/manager
 *
 * The Device Manager — the reusable facade that owns the trusted-device lifecycle
 * over a repository backend, applying trust/registration policies and emitting
 * lifecycle events. It contains NO encryption, handshake, session, or P2P logic
 * (future layers). It treats devices as first-class cryptographic entities.
 *
 * The server never stores private keys; every method operates on public material.
 */

import { DeviceAction, DeviceEventType } from "../types.js";
import { DeviceNotFoundError, DeviceOwnershipError, DeviceValidationError } from "../errors.js";
import { validateDeviceSubmission, validateMetadata } from "../validators/deviceValidators.js";
import { RegistrationPolicy } from "../policies/registrationPolicy.js";
import { DEFAULT_INACTIVITY_MS, canEstablishSession, effectiveStatus } from "../policies/trustPolicy.js";
import { planTransition } from "../lifecycle/deviceLifecycle.js";
import { toPublicDevice, toPublicDeviceList } from "../serialization/deviceSerializer.js";
import { DeviceEventBus } from "../events/deviceEvents.js";
import { NoopDeviceSync } from "../sync/deviceSync.js";

/**
 * @typedef {object} DeviceManagerDeps
 * @property {object} devices device repository (see repository contract)
 * @property {DeviceEventBus} [events] event bus (default: a new bus)
 * @property {RegistrationPolicy} [registrationPolicy] (default: new RegistrationPolicy())
 * @property {object} [sync] sync provider (default: NoopDeviceSync)
 * @property {() => number} [clock] epoch-ms clock (default Date.now)
 * @property {number} [inactivityMs] inactivity window for expiry (default 30d)
 */

/**
 * Manages trusted devices and their lifecycle.
 *
 * @example
 * ```js
 * import { createMongoDeviceRepository } from "../repository/mongoRepository.js";
 * const manager = new DeviceManager({ devices: createMongoDeviceRepository().devices });
 * manager.events.on(DeviceEventType.REVOKED, (e) => console.log("revoked", e.deviceId));
 * const device = await manager.register({ userId, identityId, deviceId, publicKey, algorithm, fingerprint });
 * ```
 */
export class DeviceManager {
  /** @param {DeviceManagerDeps} deps */
  constructor(deps) {
    if (!deps || !deps.devices) throw new Error("DeviceManager requires a { devices } repository");
    this.devices = deps.devices;
    /** @type {DeviceEventBus} */
    this.events = deps.events ?? new DeviceEventBus();
    this.registrationPolicy = deps.registrationPolicy ?? new RegistrationPolicy();
    this.sync = deps.sync ?? new NoopDeviceSync();
    this.clock = deps.clock ?? (() => Date.now());
    this.inactivityMs = deps.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  }

  // === registration ========================================================

  /**
   * Register a device (idempotent on `deviceId`). The first device for a user is
   * auto-trusted; additional devices start `pending` (per the registration policy).
   *
   * @param {{ userId: string, identityId: string, deviceId: string, publicKey: string,
   *           algorithm: string, fingerprint: string, name?: string, platform?: string,
   *           os?: string, appVersion?: string, capabilities?: string[], metadata?: object }} input
   * @returns {Promise<import("../serialization/deviceSerializer.js").PublicTrustedDeviceDTO>}
   * @throws {DeviceValidationError | DeviceOwnershipError | RegistrationPolicyError}
   */
  async register(input) {
    const {
      userId,
      identityId,
      deviceId,
      publicKey,
      algorithm,
      fingerprint,
      name,
      platform,
      os,
      appVersion,
      capabilities,
      metadata,
    } = input;

    validateDeviceSubmission({
      deviceId,
      publicKey,
      algorithm,
      fingerprint,
      name,
      platform,
      os,
      appVersion,
      capabilities,
      metadata,
    });
    this.registrationPolicy.validateName(name);
    if (typeof identityId !== "string" || identityId.length === 0) {
      throw new DeviceValidationError("identityId is required to register a device");
    }

    const nowIso = new Date(this.clock()).toISOString();
    const existing = await this.devices.findById(deviceId);

    if (existing) {
      if (String(existing.user) !== String(userId)) {
        throw new DeviceOwnershipError("Device belongs to another user");
      }
      // Idempotent refresh of mutable descriptor fields + activity; trust unchanged.
      const patch = {
        name: name ?? existing.name,
        platform: platform ?? existing.platform,
        os: os ?? existing.os,
        appVersion: appVersion ?? existing.appVersion,
        capabilities: capabilities ?? existing.capabilities,
        metadata: metadata ? { ...(existing.metadata ?? {}), ...metadata } : existing.metadata,
        lastActive: nowIso,
        updatedAt: nowIso,
      };
      const updated = await this.devices.update(deviceId, patch);
      this._emit(DeviceEventType.UPDATED, updated);
      return toPublicDevice(updated, this._evalOpts());
    }

    const currentCount = await this.devices.countByUser(userId);
    this.registrationPolicy.assertCanRegister({ currentCount });
    const trustStatus = this.registrationPolicy.initialTrustStatus(currentCount === 0);

    const record = {
      deviceId,
      identityId,
      user: userId,
      name,
      platform,
      os,
      appVersion,
      capabilities: capabilities ?? [],
      publicKey,
      algorithm,
      fingerprint,
      trustStatus,
      status: trustStatus === "revoked" ? "revoked" : "active",
      lastActive: nowIso,
      metadata: metadata ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.devices.create(record);
    this._emit(DeviceEventType.REGISTERED, created);
    return toPublicDevice(created, this._evalOpts());
  }

  // === lifecycle transitions ==============================================

  /** Activate a device → `trusted`. @throws {InvalidTrustTransitionError} */
  activate(userId, deviceId) {
    return this._transition(userId, deviceId, DeviceAction.ACTIVATE);
  }

  /** Deactivate a device → `inactive`. */
  deactivate(userId, deviceId) {
    return this._transition(userId, deviceId, DeviceAction.DEACTIVATE);
  }

  /** Revoke a device → `revoked` (terminal). @param {string} [reason] */
  revoke(userId, deviceId, reason) {
    return this._transition(userId, deviceId, DeviceAction.REVOKE, { reason });
  }

  /** Block a device → `blocked`. */
  block(userId, deviceId, reason) {
    return this._transition(userId, deviceId, DeviceAction.BLOCK, { reason });
  }

  /** Unblock a device → `trusted`. */
  unblock(userId, deviceId) {
    return this._transition(userId, deviceId, DeviceAction.UNBLOCK);
  }

  /**
   * Permanently delete a device record.
   * @returns {Promise<{ deleted: boolean }>}
   */
  async delete(userId, deviceId) {
    await this._requireOwned(userId, deviceId);
    const deleted = await this.devices.delete(deviceId);
    this._emit(DeviceEventType.DELETED, { deviceId, user: userId });
    return { deleted };
  }

  // === updates ============================================================

  /** Rename a device. @throws {DeviceValidationError} */
  async rename(userId, deviceId, name) {
    this.registrationPolicy.validateName(name);
    if (name === undefined) throw new DeviceValidationError("name is required");
    await this._requireOwned(userId, deviceId);
    const updated = await this.devices.update(deviceId, {
      name,
      updatedAt: new Date(this.clock()).toISOString(),
    });
    this._emit(DeviceEventType.UPDATED, updated);
    return toPublicDevice(updated, this._evalOpts());
  }

  /** Merge a metadata patch into a device's metadata. */
  async updateMetadata(userId, deviceId, metadata) {
    validateMetadata(metadata);
    const existing = await this._requireOwned(userId, deviceId);
    const updated = await this.devices.update(deviceId, {
      metadata: { ...(existing.metadata ?? {}), ...(metadata ?? {}) },
      updatedAt: new Date(this.clock()).toISOString(),
    });
    this._emit(DeviceEventType.UPDATED, updated);
    return toPublicDevice(updated, this._evalOpts());
  }

  /** Mark a device active now (updates `lastActive`). */
  async touch(userId, deviceId) {
    await this._requireOwned(userId, deviceId);
    const updated = await this.devices.update(deviceId, {
      lastActive: new Date(this.clock()).toISOString(),
    });
    return toPublicDevice(updated, this._evalOpts());
  }

  // === queries ============================================================

  /** List all of a user's devices. */
  async listDevices(userId) {
    return toPublicDeviceList(await this.devices.findByUser(userId), this._evalOpts());
  }

  /** List a user's trusted devices (stored trust status = trusted). */
  async listTrusted(userId) {
    return toPublicDeviceList(await this.devices.findTrusted(userId), this._evalOpts());
  }

  /** List a user's devices filtered by (stored) trust status. */
  async filterByStatus(userId, trustStatus) {
    return toPublicDeviceList(await this.devices.findByStatus(userId, trustStatus), this._evalOpts());
  }

  /** Look up one of a user's devices (ownership-enforced). @throws {DeviceNotFoundError|DeviceOwnershipError} */
  async getDevice(userId, deviceId) {
    return toPublicDevice(await this._requireOwned(userId, deviceId), this._evalOpts());
  }

  /** Get a device's fingerprint (all formats). */
  async getFingerprint(userId, deviceId) {
    const device = await this.getDevice(userId, deviceId);
    return device.fingerprint;
  }

  /**
   * Evaluate the effective trust of a device (applies inactivity expiry). If the
   * device is unknown, resolves to `{ status: "unknown" }`.
   * @returns {Promise<{ status: string }>}
   */
  async evaluateTrust(userId, deviceId) {
    const record = await this.devices.findById(deviceId);
    if (!record || String(record.user) !== String(userId)) return { status: "unknown" };
    return { status: effectiveStatus(record, this._evalOpts()) };
  }

  /**
   * The trust decision a future session layer should honour before establishing a
   * secure session with this device.
   * @returns {Promise<{ ok: boolean, status: string, reason?: string }>}
   */
  async canEstablishSession(userId, deviceId) {
    const record = await this.devices.findById(deviceId);
    if (record && String(record.user) !== String(userId)) {
      return { ok: false, status: "unknown", reason: "ownership" };
    }
    return canEstablishSession(record ?? null, this._evalOpts());
  }

  /**
   * Load a device's public trust view for the auth flow. Returns `null` if the
   * device is not registered (so the client can register it).
   * @returns {Promise<import("../serialization/deviceSerializer.js").PublicTrustedDeviceDTO|null>}
   */
  async getCurrentDeviceTrust(userId, deviceId) {
    const record = await this.devices.findById(deviceId);
    if (!record || String(record.user) !== String(userId)) return null;
    return toPublicDevice(record, this._evalOpts());
  }

  // === internals ===========================================================

  /** @private */
  async _transition(userId, deviceId, action, options = {}) {
    const record = await this._requireOwned(userId, deviceId);
    const { patch, event } = planTransition(record, action, { now: this.clock(), ...options });
    const updated = await this.devices.update(deviceId, patch);
    this._emit(event, updated, options.reason ? { reason: options.reason } : undefined);
    return toPublicDevice(updated, this._evalOpts());
  }

  /** @private */
  async _requireOwned(userId, deviceId) {
    const record = await this.devices.findById(deviceId);
    if (!record) throw new DeviceNotFoundError("Device not found", { details: { deviceId } });
    if (String(record.user) !== String(userId)) {
      throw new DeviceOwnershipError("Device belongs to another user");
    }
    return record;
  }

  /** @private Emit an event and best-effort publish to the sync provider. */
  _emit(type, record, details) {
    const deviceId = record.deviceId;
    const userId = String(record.user);
    const event = { deviceId, userId };
    if (record.publicKey) event.device = toPublicDevice(record, this._evalOpts());
    if (details) event.details = details;
    this.events.emit(type, event);
    // Fire-and-forget cross-device sync (no-op in Sprint 2).
    Promise.resolve(this.sync.publish(userId, { type, ...event })).catch(() => {});
  }

  /** @private */
  _evalOpts() {
    return { now: this.clock(), inactivityMs: this.inactivityMs };
  }
}

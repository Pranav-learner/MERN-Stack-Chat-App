/**
 * @module identity/manager
 *
 * The Identity Manager — the reusable facade that orchestrates identity and
 * device lifecycle over a repository backend. It contains NO transport, HTTP, or
 * chat logic and NO encryption (that is a future layer). It only manages the
 * establishment, lookup, and validation of cryptographic identities.
 *
 * The server never receives or stores private keys; every method here operates on
 * public material only.
 */

import crypto from "node:crypto";
import {
  DeviceNotFoundError,
  DuplicateIdentityError,
  IdentityNotFoundError,
  IdentityOwnershipError,
} from "../errors.js";
import { validatePublicKeySubmission, validateDeviceDescriptor } from "../validators/identityValidators.js";
import { verifyFingerprint, fingerprintFormats } from "../fingerprints/fingerprint.js";
import { decodePublicKey } from "../validators/identityValidators.js";
import {
  toPublicIdentity,
  toPublicDevice,
  toPublicKeyBundle,
} from "../serialization/identitySerializer.js";

/**
 * @typedef {object} IdentityManagerDeps
 * @property {object} identities identity repository (see repository contract)
 * @property {object} devices device repository
 * @property {() => number} [clock] epoch-ms clock (default `Date.now`)
 * @property {() => string} [idGenerator] identity-id generator (default `randomUUID`)
 */

/**
 * Orchestrates cryptographic identities and their devices.
 *
 * @example
 * ```js
 * import { createMongoRepositories } from "../repository/mongoRepository.js";
 * const manager = new IdentityManager(createMongoRepositories());
 * const { identity, device } = await manager.registerIdentity({
 *   userId, publicKey, algorithm: "ed25519", fingerprint, device: { deviceId, name, platform, publicKey: dpk, algorithm: "ed25519", fingerprint: dfp },
 * });
 * ```
 */
export class IdentityManager {
  /** @param {IdentityManagerDeps} deps */
  constructor(deps) {
    if (!deps || !deps.identities || !deps.devices) {
      throw new Error("IdentityManager requires { identities, devices } repositories");
    }
    this.identities = deps.identities;
    this.devices = deps.devices;
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
  }

  /**
   * Establish (or idempotently return) the caller's identity, optionally
   * registering the calling device in the same call.
   *
   * @param {{ userId: string, publicKey: string, algorithm: string, fingerprint: string,
   *           metadata?: object, device?: object }} input
   * @returns {Promise<{ identity: import("../serialization/identitySerializer.js").PublicIdentityDTO,
   *                     device: (import("../serialization/identitySerializer.js").PublicDeviceDTO|null) }>}
   * @throws {IdentityValidationError} malformed key / fingerprint mismatch
   * @throws {DuplicateIdentityError} user already has a *different* identity
   */
  async registerIdentity(input) {
    const { userId, publicKey, algorithm, fingerprint, metadata, device } = input;
    validatePublicKeySubmission({ publicKey, algorithm, fingerprint });

    let record = await this.identities.findByUser(userId);
    if (record) {
      // Idempotent: same key → return existing; different key → conflict.
      if (record.publicKey !== publicKey) {
        throw new DuplicateIdentityError(
          "User already has a different identity; rotation is a future capability",
          { details: { userId: String(userId) } },
        );
      }
    } else {
      const now = new Date(this.clock()).toISOString();
      record = await this.identities.create({
        identityId: this.idGenerator(),
        user: userId,
        publicKey,
        algorithm,
        fingerprint,
        version: 1,
        status: "active",
        metadata: metadata ?? {},
        createdAt: now,
        updatedAt: now,
      });
    }

    let devicePublic = null;
    if (device) {
      devicePublic = await this.registerDevice({
        userId,
        identityId: record.identityId,
        ...device,
      });
    }
    return { identity: toPublicIdentity(record), device: devicePublic };
  }

  /**
   * Register (or idempotently refresh) a device under an identity owned by the user.
   *
   * @param {{ userId: string, identityId: string, deviceId: string, name?: string,
   *           platform?: string, publicKey: string, algorithm: string, fingerprint: string }} input
   * @returns {Promise<import("../serialization/identitySerializer.js").PublicDeviceDTO>}
   * @throws {IdentityValidationError | IdentityNotFoundError | IdentityOwnershipError}
   */
  async registerDevice(input) {
    const { userId, identityId, deviceId, name, platform, publicKey, algorithm, fingerprint } = input;
    validateDeviceDescriptor({ deviceId, name, platform });
    validatePublicKeySubmission({ publicKey, algorithm, fingerprint });

    const identity = await this.identities.findById(identityId);
    if (!identity) throw new IdentityNotFoundError("Identity not found", { details: { identityId } });
    if (String(identity.user) !== String(userId)) {
      throw new IdentityOwnershipError("Identity does not belong to the caller");
    }

    const now = new Date(this.clock()).toISOString();
    const existing = await this.devices.findById(deviceId);
    if (existing) {
      if (String(existing.user) !== String(userId)) {
        throw new IdentityOwnershipError("Device belongs to another user");
      }
      const updated = await this.devices.update(deviceId, {
        lastActive: now,
        name: name ?? existing.name,
        platform: platform ?? existing.platform,
        updatedAt: now,
      });
      return toPublicDevice(updated);
    }

    const record = await this.devices.create({
      deviceId,
      identityId,
      user: userId,
      name,
      platform,
      publicKey,
      algorithm,
      fingerprint,
      status: "active",
      lastActive: now,
      createdAt: now,
      updatedAt: now,
    });
    return toPublicDevice(record);
  }

  /**
   * Load the caller's public identity, or `null` if none exists yet.
   * @param {string} userId
   * @returns {Promise<import("../serialization/identitySerializer.js").PublicIdentityDTO|null>}
   */
  async getIdentityByUser(userId) {
    const record = await this.identities.findByUser(userId);
    return record ? toPublicIdentity(record) : null;
  }

  /**
   * Retrieve a user's identity public-key bundle (for key distribution).
   * @param {string} userId
   * @returns {Promise<{userId: string, publicKey: string, algorithm: string, fingerprint: object}>}
   * @throws {IdentityNotFoundError}
   */
  async getPublicKey(userId) {
    const record = await this.requireIdentity(userId);
    return toPublicKeyBundle(record);
  }

  /**
   * Retrieve a user's identity fingerprint in all display formats.
   * @param {string} userId
   * @returns {Promise<{ machine: string, human: string, numeric: string }>}
   * @throws {IdentityNotFoundError}
   */
  async getFingerprint(userId) {
    const record = await this.requireIdentity(userId);
    return fingerprintFormats(record.fingerprint);
  }

  /**
   * List the caller's registered devices (public DTOs).
   * @param {string} userId
   * @returns {Promise<import("../serialization/identitySerializer.js").PublicDeviceDTO[]>}
   */
  async listDevices(userId) {
    const records = await this.devices.findByUser(userId);
    return records.map(toPublicDevice);
  }

  /**
   * Look up one of the caller's devices by id (ownership-enforced).
   * @param {string} userId
   * @param {string} deviceId
   * @returns {Promise<import("../serialization/identitySerializer.js").PublicDeviceDTO>}
   * @throws {DeviceNotFoundError | IdentityOwnershipError}
   */
  async getDevice(userId, deviceId) {
    const record = await this.devices.findById(deviceId);
    if (!record) {
      throw new DeviceNotFoundError("Device not found", { details: { deviceId } });
    }
    if (String(record.user) !== String(userId)) {
      throw new IdentityOwnershipError("Device belongs to another user");
    }
    return toPublicDevice(record);
  }

  /**
   * Mark a device active now (updates `lastActive`).
   * @param {string} userId
   * @param {string} deviceId
   * @returns {Promise<import("../serialization/identitySerializer.js").PublicDeviceDTO>}
   */
  async touchDevice(userId, deviceId) {
    await this.getDevice(userId, deviceId); // ownership check
    const updated = await this.devices.update(deviceId, {
      lastActive: new Date(this.clock()).toISOString(),
    });
    return toPublicDevice(updated);
  }

  /**
   * Validate a stored identity's integrity: status active and the stored
   * fingerprint matches the stored public key.
   * @param {string} userId
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async validateIdentity(userId) {
    const record = await this.identities.findByUser(userId);
    if (!record) return { ok: false, reason: "no-identity" };
    if (record.status !== "active") return { ok: false, reason: `status-${record.status}` };
    let bytes;
    try {
      bytes = decodePublicKey(record.publicKey);
    } catch {
      return { ok: false, reason: "corrupt-public-key" };
    }
    if (!verifyFingerprint(bytes, record.fingerprint)) {
      return { ok: false, reason: "fingerprint-mismatch" };
    }
    return { ok: true };
  }

  // --- internals -----------------------------------------------------------

  /** @private */
  async requireIdentity(userId) {
    const record = await this.identities.findByUser(userId);
    if (!record) {
      throw new IdentityNotFoundError("Identity not found for user", {
        details: { userId: String(userId) },
      });
    }
    return record;
  }
}

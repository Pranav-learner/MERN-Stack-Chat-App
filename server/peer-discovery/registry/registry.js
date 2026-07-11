/**
 * @module peer-discovery/registry
 *
 * The **Discovery Registry** — the index of discoverable peer descriptors. It answers
 * *"which devices does this user have, and what is their public identity?"* by combining
 * two sources:
 *
 * 1. an explicit registry store (`entries` repository) that devices self-register into;
 * 2. an authoritative {@link module:peer-discovery/registry/directory directory provider}
 *    (the Layer 3 identity/device store) used to HYDRATE the registry on a miss.
 *
 * On a lookup miss, the registry pulls the user's identity + devices from the directory,
 * upserts them as descriptors, and returns them — so discovery works even before a device
 * self-registers, while a self-registered device stays authoritative for its own entry.
 *
 * @security The registry stores + returns PUBLIC descriptors ONLY (public identity/device
 * keys + fingerprints, statuses, inert placeholders). It never stores or returns private
 * keys, session keys, message keys, chain keys, or shared secrets. Descriptors are
 * validated for the no-secret invariant before storage.
 *
 * @evolution Transport-independent: the registry knows WHO a peer is and WHICH devices
 * they have, never HOW to reach them. Future sprints (Presence, NAT Traversal) populate
 * the presence/transport placeholders on the descriptors it returns.
 */

import {
  DiscoverySource,
  DISCOVERABLE_REGISTRY_STATUSES,
  DiscoveryEventType,
} from "../types/types.js";
import {
  createDeviceDescriptor,
  createIdentityDescriptor,
  createDiscoveryMetadata,
} from "../metadata/metadata.js";
import { isDirectoryProvider } from "./directory.js";
import { assertNoSecretMaterial, validateUserRef, validateDeviceRef } from "../validators/validators.js";
import { UnknownUserError, UnknownDeviceError, DirectoryUnavailableError } from "../errors.js";
import { DiscoveryEventBus } from "../events/events.js";

/**
 * @typedef {object} RegistryDeps
 * @property {object} entries a registry-entry repository (see repository contract)
 * @property {object} [directory] an authoritative directory provider (optional)
 * @property {DiscoveryEventBus} [events]
 * @property {() => number} [clock]
 * @property {boolean} [hydrateFromDirectory=true] hydrate the registry on a miss
 */

export class DiscoveryRegistry {
  /** @param {RegistryDeps} deps */
  constructor(deps) {
    if (!deps || !deps.entries) throw new Error("DiscoveryRegistry requires { entries }");
    this.entries = deps.entries;
    this.directory = deps.directory ?? null;
    this.events = deps.events ?? new DiscoveryEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.hydrateFromDirectory = deps.hydrateFromDirectory !== false;
    if (this.directory && !isDirectoryProvider(this.directory)) {
      throw new Error("DiscoveryRegistry directory must implement getIdentity() + getDevices()");
    }
  }

  // === registration ========================================================

  /**
   * Register (or update) a discoverable device descriptor. Idempotent by `deviceId`.
   * Emits `DEVICE_REGISTERED`.
   * @param {object} device a raw device record
   * @returns {Promise<import("../types/types.js").DeviceDescriptor>}
   */
  async registerDevice(device) {
    validateUserRef(device?.userId);
    validateDeviceRef(device?.deviceId);
    const descriptor = createDeviceDescriptor(device, { now: this._nowIso() });
    assertNoSecretMaterial(descriptor);
    const stored = await this.entries.upsert(descriptor);
    this.events.emit(DiscoveryEventType.DEVICE_REGISTERED, {
      userId: descriptor.userId,
      deviceId: descriptor.deviceId,
    });
    return stored;
  }

  /**
   * Deregister a device (remove it from the registry). Emits `DEVICE_DEREGISTERED`.
   * @param {string} userId @param {string} deviceId
   * @returns {Promise<boolean>} whether an entry was removed
   */
  async deregisterDevice(userId, deviceId) {
    validateUserRef(userId);
    validateDeviceRef(deviceId);
    const removed = await this.entries.remove(String(userId), String(deviceId));
    if (removed) {
      this.events.emit(DiscoveryEventType.DEVICE_DEREGISTERED, { userId: String(userId), deviceId: String(deviceId) });
    }
    return removed;
  }

  // === resolution ==========================================================

  /**
   * Resolve every discoverable device descriptor for a user (registry first, then the
   * directory on a miss). Returns `[]` when the user is unknown.
   * @param {string} userId
   * @returns {Promise<{ devices: import("../types/types.js").DeviceDescriptor[], source: string }>}
   */
  async resolveUserDevices(userId) {
    validateUserRef(userId);
    const uid = String(userId);
    let devices = discoverable(await this.entries.findByUser(uid));
    if (devices.length > 0) return { devices, source: DiscoverySource.REGISTRY };

    if (this.hydrateFromDirectory && this.directory) {
      const hydrated = await this._hydrate(uid);
      if (hydrated.length > 0) return { devices: discoverable(hydrated), source: DiscoverySource.DIRECTORY };
    }
    return { devices: [], source: DiscoverySource.REGISTRY };
  }

  /**
   * Resolve a single device descriptor. @throws {UnknownDeviceError}
   * @param {string} userId @param {string} deviceId
   * @returns {Promise<import("../types/types.js").DeviceDescriptor>}
   */
  async resolveDevice(userId, deviceId) {
    validateUserRef(userId);
    validateDeviceRef(deviceId);
    const { devices } = await this.resolveUserDevices(userId);
    const match = devices.find((d) => d.deviceId === String(deviceId));
    if (!match) {
      throw new UnknownDeviceError(`Device "${deviceId}" is not discoverable for user "${userId}"`, {
        details: { userId: String(userId), deviceId: String(deviceId) },
      });
    }
    return match;
  }

  /**
   * Resolve a specific subset of a user's devices. Unknown device ids raise
   * {@link UnknownDeviceError}. An empty `deviceIds` resolves ALL devices.
   * @param {string} userId @param {string[]} [deviceIds]
   * @returns {Promise<{ devices: import("../types/types.js").DeviceDescriptor[], source: string }>}
   */
  async resolveDevices(userId, deviceIds = []) {
    const { devices, source } = await this.resolveUserDevices(userId);
    const wanted = (deviceIds ?? []).map(String);
    if (wanted.length === 0) return { devices, source };
    const byId = new Map(devices.map((d) => [d.deviceId, d]));
    const missing = wanted.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new UnknownDeviceError(`Devices not discoverable for user "${userId}": ${missing.join(", ")}`, {
        details: { userId: String(userId), missing },
      });
    }
    return { devices: wanted.map((id) => byId.get(id)), source };
  }

  /**
   * Resolve a user's public identity descriptor (registry devices carry `identityId`;
   * the full public identity comes from the directory when available).
   * @param {string} userId
   * @returns {Promise<import("../types/types.js").PublicIdentityDescriptor|null>}
   */
  async resolveIdentity(userId) {
    validateUserRef(userId);
    if (this.directory) {
      try {
        const identity = await this.directory.getIdentity(String(userId));
        if (identity) return createIdentityDescriptor(identity);
      } catch (error) {
        throw new DirectoryUnavailableError("Directory identity lookup failed", { cause: error, details: { userId: String(userId) } });
      }
    }
    return null;
  }

  /**
   * Resolve a user's full {@link DiscoveryMetadata} — the "Resolve Discovery Metadata"
   * output combining public identity + discoverable devices.
   * @param {string} userId @param {{ deviceIds?: string[] }} [options]
   * @returns {Promise<import("../types/types.js").DiscoveryMetadata>}
   * @throws {UnknownUserError} when neither identity nor any device can be resolved
   */
  async resolveMetadata(userId, options = {}) {
    validateUserRef(userId);
    const uid = String(userId);
    const [{ devices, source }, identity] = await Promise.all([
      this.resolveDevices(uid, options.deviceIds ?? []),
      this.resolveIdentity(uid),
    ]);
    if (!identity && devices.length === 0) {
      throw new UnknownUserError(`No discoverable identity or devices for user "${uid}"`, { details: { userId: uid } });
    }
    const metadata = createDiscoveryMetadata({ userId: uid, identity, devices, source, at: this._nowIso() });
    assertNoSecretMaterial(metadata);
    return metadata;
  }

  // === internals ==========================================================

  /** @private Hydrate the registry from the directory for a user; returns the descriptors. */
  async _hydrate(userId) {
    let rawDevices;
    try {
      rawDevices = await this.directory.getDevices(userId);
    } catch (error) {
      throw new DirectoryUnavailableError("Directory device lookup failed", { cause: error, details: { userId } });
    }
    const descriptors = (rawDevices ?? []).map((d) =>
      createDeviceDescriptor({ ...d, userId }, { now: this._nowIso() }),
    );
    // Upsert quietly (no per-device event) so the registry warms without noise.
    await Promise.all(descriptors.map((d) => this.entries.upsert(d)));
    return descriptors;
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Keep only discoverable descriptors (status filter). */
function discoverable(descriptors) {
  return (descriptors ?? []).filter((d) => DISCOVERABLE_REGISTRY_STATUSES.includes(d.status));
}

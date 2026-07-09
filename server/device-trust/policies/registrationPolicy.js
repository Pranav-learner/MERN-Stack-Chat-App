/**
 * @module device-trust/policies/registrationPolicy
 *
 * Rules governing device registration: per-user device limits, naming rules, and
 * the initial trust status assigned to a newly registered device.
 */

import { TrustStatus } from "../types.js";
import { RegistrationPolicyError, DeviceValidationError } from "../errors.js";

/**
 * Configurable device registration policy.
 *
 * @example
 * const policy = new RegistrationPolicy({ maxDevicesPerUser: 5 });
 * policy.assertCanRegister({ currentCount: 4 }); // ok
 */
export class RegistrationPolicy {
  /**
   * @param {{ maxDevicesPerUser?: number, autoTrustFirstDevice?: boolean, maxNameLength?: number }} [options]
   */
  constructor(options = {}) {
    /** Maximum devices a single user may register. */
    this.maxDevicesPerUser = options.maxDevicesPerUser ?? 10;
    /** Whether the very first device for a user is auto-trusted. */
    this.autoTrustFirstDevice = options.autoTrustFirstDevice ?? true;
    /** Maximum device name length. */
    this.maxNameLength = options.maxNameLength ?? 64;
  }

  /**
   * The initial trust status for a newly-registered device.
   * @param {boolean} isFirstDevice whether the user has no devices yet
   * @returns {string} {@link TrustStatus}
   */
  initialTrustStatus(isFirstDevice) {
    return isFirstDevice && this.autoTrustFirstDevice ? TrustStatus.TRUSTED : TrustStatus.PENDING;
  }

  /**
   * Assert the user is under the device limit.
   * @param {{ currentCount: number }} ctx
   * @throws {RegistrationPolicyError}
   */
  assertCanRegister({ currentCount }) {
    if (currentCount >= this.maxDevicesPerUser) {
      throw new RegistrationPolicyError(
        `Device limit reached (${this.maxDevicesPerUser}). Revoke a device before adding another.`,
        { details: { limit: this.maxDevicesPerUser, currentCount } },
      );
    }
  }

  /**
   * Validate a device name against the naming rules.
   * @param {string} [name]
   * @throws {DeviceValidationError}
   */
  validateName(name) {
    if (name === undefined) return;
    if (typeof name !== "string" || name.length === 0) {
      throw new DeviceValidationError("Device name must be a non-empty string");
    }
    if (name.length > this.maxNameLength) {
      throw new DeviceValidationError(`Device name exceeds ${this.maxNameLength} characters`);
    }
  }
}

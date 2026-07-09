/**
 * @module device-trust/sync
 *
 * Multi-device SYNC abstraction (future hook). Later layers will use this to
 * propagate device-list / trust changes across a user's devices (e.g. when a new
 * device is added or revoked, other devices learn about it). Sprint 2 ships only
 * the interface and a no-op implementation — no cross-device sync is performed.
 */

/**
 * A device sync provider.
 * @typedef {object} DeviceSyncProvider
 * @property {string} name
 * @property {(userId: string, event: object) => Promise<void>} publish push a change to a user's other devices
 * @property {(userId: string) => Promise<object[]>} pull fetch pending changes for a device
 */

/**
 * No-op sync provider (default). Records nothing and returns nothing. Present so
 * the {@link DeviceManager} can be wired with sync now and swapped later.
 * @implements {DeviceSyncProvider}
 */
export class NoopDeviceSync {
  constructor() {
    this.name = "noop";
  }

  /** @returns {Promise<void>} */
  async publish() {
    /* no-op — cross-device sync is a future layer */
  }

  /** @returns {Promise<object[]>} */
  async pull() {
    return [];
  }
}

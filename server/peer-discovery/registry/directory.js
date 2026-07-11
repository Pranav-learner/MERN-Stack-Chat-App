/**
 * @module peer-discovery/registry/directory
 *
 * The **Directory Provider** contract + an in-memory reference implementation. A
 * directory is the AUTHORITATIVE source of a user's public identity and devices — on the
 * server it is backed by the Layer 3 identity/device store; in tests it is backed by an
 * in-memory map. The {@link module:peer-discovery/registry DiscoveryRegistry} hydrates
 * itself from a directory when a user has no explicitly-registered entries, so discovery
 * works even before a device self-registers.
 *
 * ## Contract
 * A directory provider is any object with:
 * - `getIdentity(userId) -> Promise<identity | null>` — a public identity record
 *   (`{ identityId, publicKey, algorithm, fingerprint, version }`), or null.
 * - `getDevices(userId) -> Promise<device[]>` — the user's PUBLIC device records
 *   (`{ deviceId, identityId, publicKey, algorithm, fingerprint, name, platform, status|trustStatus }`).
 *
 * @security A directory returns PUBLIC material ONLY — public identity/device keys and
 * fingerprints. It must never surface a private key, session key, or shared secret.
 * Directory read failures are surfaced as {@link DirectoryUnavailableError} by callers.
 */

/**
 * Build an in-memory directory provider (for tests + device-local use). Seed it with
 * users → `{ identity, devices }`.
 *
 * @param {Record<string, { identity?: object, devices?: object[] }>} [seed]
 * @returns {{ getIdentity: (userId: string) => Promise<object|null>, getDevices: (userId: string) => Promise<object[]>, set: (userId: string, entry: object) => void, addDevice: (userId: string, device: object) => void, remove: (userId: string) => void, clear: () => void }}
 */
export function createInMemoryDirectory(seed = {}) {
  /** @type {Map<string, { identity: object|null, devices: object[] }>} */
  const byUser = new Map();
  for (const [userId, entry] of Object.entries(seed)) {
    byUser.set(String(userId), { identity: entry.identity ?? null, devices: entry.devices ?? [] });
  }

  return {
    async getIdentity(userId) {
      const entry = byUser.get(String(userId));
      return entry?.identity ? { ...entry.identity } : null;
    },
    async getDevices(userId) {
      const entry = byUser.get(String(userId));
      return (entry?.devices ?? []).map((d) => ({ ...d }));
    },
    /** Seed/replace a user's whole directory entry. */
    set(userId, entry) {
      byUser.set(String(userId), { identity: entry.identity ?? null, devices: entry.devices ?? [] });
    },
    /** Add a single device to a user's directory entry. */
    addDevice(userId, device) {
      const key = String(userId);
      const entry = byUser.get(key) ?? { identity: null, devices: [] };
      entry.devices = [...entry.devices.filter((d) => d.deviceId !== device.deviceId), { ...device }];
      byUser.set(key, entry);
    },
    /** Remove a user's directory entry. */
    remove(userId) {
      byUser.delete(String(userId));
    },
    clear() {
      byUser.clear();
    },
  };
}

/**
 * Whether an object satisfies the directory-provider contract.
 * @param {any} directory @returns {boolean}
 */
export function isDirectoryProvider(directory) {
  return (
    !!directory &&
    typeof directory.getIdentity === "function" &&
    typeof directory.getDevices === "function"
  );
}

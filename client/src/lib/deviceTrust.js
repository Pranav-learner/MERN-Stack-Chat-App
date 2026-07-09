/**
 * Client-side Device Trust integration (Layer 3, Sprint 2).
 *
 * Builds on the Sprint 1 identity module (`identity.js`): the device keypair is
 * already generated and stored locally there. This module enriches the device
 * with trust metadata (OS, app version, capabilities), registers its PUBLIC key
 * with the device-trust API, and caches the current device + trust status locally.
 *
 * Private keys never leave the browser — only public device data is sent.
 * This module manages trusted devices; it does NOT encrypt anything.
 */

import { getOrCreateLocalDevice, devicePublicPayload } from "./identity.js";

/** Client app version reported to the server. */
export const APP_VERSION = "1.0.0";

const STORAGE_VERSION = "v1";
const TRUST_CACHE_KEY = (userId) => `securechat.deviceTrust.${STORAGE_VERSION}.${userId}`;

/** Best-effort OS detection from the user agent. */
function detectOS() {
  const ua = globalThis.navigator?.userAgent ?? "";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "unknown";
}

/** Capabilities this client advertises (no cryptographic capability yet). */
function defaultCapabilities() {
  return ["messaging"];
}

function cacheTrust(userId, device) {
  try {
    localStorage.setItem(
      TRUST_CACHE_KEY(userId),
      JSON.stringify({
        deviceId: device.deviceId,
        fingerprint: device.fingerprint?.machine ?? device.fingerprint,
        trustStatus: device.effectiveTrustStatus ?? device.trustStatus,
        name: device.name,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    /* ignore quota/storage errors */
  }
}

/** Read the cached current-device trust snapshot (offline-friendly). */
export function getCachedDeviceTrust(userId) {
  try {
    const raw = localStorage.getItem(TRUST_CACHE_KEY(userId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Ensure this browser's device is registered with the device-trust service and
 * cache its trust status. Idempotent and failure-tolerant (never throws into the
 * auth flow). Call AFTER the identity has been registered (Sprint 1), because the
 * server requires an identity before devices.
 *
 * @param {import("axios").AxiosInstance} axios
 * @param {string} userId
 * @returns {Promise<{ registered: boolean, device?: object, reason?: string }>}
 */
export async function ensureDeviceRegistered(axios, userId) {
  try {
    const localDevice = await getOrCreateLocalDevice(userId);
    if (!localDevice) return { registered: false, reason: "no-local-device" };

    const payload = {
      ...devicePublicPayload(localDevice), // deviceId, name, platform, publicKey, algorithm, fingerprint
      os: detectOS(),
      appVersion: APP_VERSION,
      capabilities: defaultCapabilities(),
    };
    const { data } = await axios.post("/api/devices/register", payload);
    if (data?.success && data.device) cacheTrust(userId, data.device);
    return { registered: !!data?.success, device: data?.device };
  } catch (error) {
    console.warn("[device-trust] registration skipped:", error?.message ?? error);
    return { registered: false, reason: "request-failed" };
  }
}

/** Fetch all of the user's devices (public DTOs). */
export async function fetchDevices(axios) {
  const { data } = await axios.get("/api/devices");
  return data?.devices ?? [];
}

/** Fetch the user's trusted devices. */
export async function fetchTrustedDevices(axios) {
  const { data } = await axios.get("/api/devices/trusted");
  return data?.devices ?? [];
}

/** Fetch and cache the current device's trust status. */
export async function refreshCurrentDeviceTrust(axios, userId) {
  const localDevice = await getOrCreateLocalDevice(userId);
  if (!localDevice) return null;
  try {
    const { data } = await axios.get(`/api/devices/${localDevice.deviceId}`);
    if (data?.success && data.device) {
      cacheTrust(userId, data.device);
      return data.device;
    }
  } catch {
    /* fall through to cached */
  }
  return getCachedDeviceTrust(userId);
}

/** Revoke a device by id. */
export async function revokeDevice(axios, deviceId, reason) {
  const { data } = await axios.post(`/api/devices/${deviceId}/revoke`, { reason });
  return data?.device;
}

/** Rename a device by id. */
export async function renameDevice(axios, deviceId, name) {
  const { data } = await axios.patch(`/api/devices/${deviceId}/rename`, { name });
  return data?.device;
}

/** Activate a pending/inactive device. */
export async function activateDevice(axios, deviceId) {
  const { data } = await axios.post(`/api/devices/${deviceId}/activate`);
  return data?.device;
}

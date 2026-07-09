/**
 * Client identity store (Layer 3, Sprint 4 — integration).
 *
 * Loads and caches the consolidated **identity context** (identity + devices +
 * current-device trust + verification summary) from `/api/session/context`, and
 * provides the lifecycle helpers the app uses:
 *
 *   Startup → load context → Ready
 *   Logout  → clear cached context
 *   Device revoked → session invalid → caller invalidates the session
 *
 * Public data only; private keys never leave the device.
 */

import { getOrCreateLocalDevice, getLocalDeviceId } from "./identity.js";

const CACHE_KEY = (userId) => `securechat.session.v1.${userId}`;

function writeCache(userId, context) {
  try {
    localStorage.setItem(CACHE_KEY(userId), JSON.stringify({ context, at: new Date().toISOString() }));
  } catch {
    /* ignore storage errors */
  }
}

function readCache(userId) {
  try {
    const raw = localStorage.getItem(CACHE_KEY(userId));
    return raw ? JSON.parse(raw).context : null;
  } catch {
    return null;
  }
}

/**
 * Load (and cache) the identity context for a user. Failure-tolerant: on a
 * network error it returns the last cached context (offline-friendly).
 *
 * @param {import("axios").AxiosInstance} axios
 * @param {string} userId
 * @returns {Promise<object|null>} the identity context, or null
 */
export async function loadIdentityContext(axios, userId) {
  // Ensure the local device exists so we can tag the request with its id.
  let deviceId = getLocalDeviceId(userId);
  if (!deviceId) {
    const device = await getOrCreateLocalDevice(userId);
    deviceId = device?.deviceId ?? null;
  }
  try {
    const { data } = await axios.get("/api/session/context", {
      params: deviceId ? { deviceId } : {},
    });
    if (data?.success) {
      writeCache(userId, data.context);
      return data.context;
    }
  } catch (error) {
    console.warn("[identity] context load failed, using cache:", error?.message ?? error);
  }
  return readCache(userId);
}

/** Read the cached identity context (no network). */
export function getCachedIdentityContext(userId) {
  return readCache(userId);
}

/** Clear the cached identity context (call on logout). Does NOT delete device keys. */
export function clearIdentityContext(userId) {
  try {
    localStorage.removeItem(CACHE_KEY(userId));
  } catch {
    /* ignore */
  }
}

/**
 * Whether a loaded context means the session should be invalidated (the current
 * device is registered but no longer trusted — e.g. revoked/blocked).
 * @param {object|null} context
 * @returns {boolean}
 */
export function contextRequiresLogout(context) {
  return !!(context && context.currentDevice && context.sessionValid === false);
}

/** Ask the server whether this (user, device) session is still valid. */
export async function validateSession(axios, userId) {
  const deviceId = getLocalDeviceId(userId);
  try {
    const { data } = await axios.get("/api/session/validate", {
      params: deviceId ? { deviceId } : {},
    });
    return data;
  } catch {
    return { valid: true, reason: "offline" }; // fail-open: don't lock users out on a network blip
  }
}

/**
 * Client-side cryptographic identity (Layer 3, Sprint 1).
 *
 * ## Why Web Crypto and not the Node Crypto SDK
 * The Layer 2 Crypto SDK (`@securechat/crypto-sdk`) runs on Node (`node:crypto`)
 * and cannot execute in the browser. This module therefore uses the browser-native
 * **Web Crypto API** to produce identities in the *exact same spec* the SDK/server
 * use, so keys and fingerprints are fully interoperable:
 *
 * - Algorithm: **Ed25519** (raw 32-byte public keys).
 * - Fingerprint: **SHA-256(rawPublicKey)** as lowercase hex — identical to the
 *   SDK's `fingerprint()` and the server's `computeFingerprint()`.
 *
 * ## Privacy invariant
 * Private keys are generated locally and stored ONLY in `localStorage` (as JWK).
 * The `*PublicPayload` helpers are the ONLY thing sent to the server — they never
 * include private material.
 *
 * This module establishes identity only. It does NOT encrypt messages.
 */

const STORAGE_VERSION = "v1";
const IDENTITY_KEY = (userId) => `securechat.identity.${STORAGE_VERSION}.${userId}`;
const DEVICE_KEY = (userId) => `securechat.device.${STORAGE_VERSION}.${userId}`;

let cachedSupport = null;

/** @returns {boolean} whether `crypto.subtle` exists at all. */
function hasSubtle() {
  return typeof globalThis.crypto !== "undefined" && !!globalThis.crypto.subtle;
}

/**
 * Feature-detect Ed25519 support in Web Crypto (browser-dependent).
 * @returns {Promise<boolean>}
 */
export async function isIdentitySupported() {
  if (cachedSupport !== null) return cachedSupport;
  if (!hasSubtle()) {
    cachedSupport = false;
    return false;
  }
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    cachedSupport = true;
  } catch {
    cachedSupport = false;
  }
  return cachedSupport;
}

// --- encoding helpers -------------------------------------------------------

function bytesToBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fingerprintHex(rawPublicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return bytesToHex(digest);
}

function randomId(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

// --- key generation ---------------------------------------------------------

/** Generate an Ed25519 key pair and its public/fingerprint material. */
async function generateKeyMaterial() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    publicKey: bytesToBase64(rawPub),
    // JWK includes the private scalar `d` — stored locally, NEVER transmitted.
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
    fingerprint: await fingerprintHex(rawPub),
    algorithm: "ed25519",
  };
}

// --- platform detection -----------------------------------------------------

function detectPlatform() {
  const ua = globalThis.navigator?.userAgent ?? "unknown";
  const plat = globalThis.navigator?.platform ?? "";
  let browser = "browser";
  if (/Firefox/.test(ua)) browser = "Firefox";
  else if (/Edg/.test(ua)) browser = "Edge";
  else if (/Chrome/.test(ua)) browser = "Chrome";
  else if (/Safari/.test(ua)) browser = "Safari";
  return `web (${browser}${plat ? ` on ${plat}` : ""})`;
}

function defaultDeviceName() {
  return `Web · ${detectPlatform().replace(/^web \(|\)$/g, "")}`;
}

// --- local persistence (private keys never leave here) ----------------------

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/**
 * Load the user's local identity, generating and persisting one if absent.
 * @param {string} userId
 * @returns {Promise<object|null>} identity record (incl. local private JWK), or `null` if unsupported
 */
export async function getOrCreateLocalIdentity(userId) {
  const existing = readLocal(IDENTITY_KEY(userId));
  if (existing) return existing;
  if (!(await isIdentitySupported())) return null;
  const material = await generateKeyMaterial();
  const record = { ...material, createdAt: new Date().toISOString() };
  writeLocal(IDENTITY_KEY(userId), record);
  return record;
}

/**
 * Load this browser's device identity for the user, generating one if absent.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getOrCreateLocalDevice(userId) {
  const existing = readLocal(DEVICE_KEY(userId));
  if (existing) return existing;
  if (!(await isIdentitySupported())) return null;
  const material = await generateKeyMaterial();
  const record = {
    deviceId: `dev_${randomId()}`,
    name: defaultDeviceName(),
    platform: detectPlatform(),
    ...material,
    registeredAt: new Date().toISOString(),
  };
  writeLocal(DEVICE_KEY(userId), record);
  return record;
}

// --- public payloads (safe to send to the server) ---------------------------

/** Public identity payload — excludes the private JWK. */
export function identityPublicPayload(identity) {
  return {
    publicKey: identity.publicKey,
    algorithm: identity.algorithm,
    fingerprint: identity.fingerprint,
  };
}

/** Public device payload — excludes the private JWK. */
export function devicePublicPayload(device) {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    publicKey: device.publicKey,
    algorithm: device.algorithm,
    fingerprint: device.fingerprint,
  };
}

/**
 * Ensure the authenticated user has a local identity + device and that their
 * PUBLIC keys are registered with the server. Idempotent and failure-tolerant:
 * it never throws into the auth flow (chat keeps working even if this fails).
 *
 * @param {import("axios").AxiosInstance} axios the app's configured axios instance
 * @param {string} userId
 * @returns {Promise<{ registered: boolean, reason?: string }>}
 */
export async function ensureIdentityRegistered(axios, userId) {
  try {
    if (!(await isIdentitySupported())) {
      return { registered: false, reason: "web-crypto-ed25519-unsupported" };
    }
    const identity = await getOrCreateLocalIdentity(userId);
    const device = await getOrCreateLocalDevice(userId);
    if (!identity || !device) return { registered: false, reason: "keygen-failed" };

    await axios.post("/api/identity/register", {
      identity: identityPublicPayload(identity),
      device: devicePublicPayload(device),
    });
    return { registered: true };
  } catch (error) {
    // Non-fatal: identity is additive. Log and continue.
    console.warn("[identity] registration skipped:", error?.message ?? error);
    return { registered: false, reason: "request-failed" };
  }
}

/**
 * Read the local identity fingerprint for display (e.g. safety number UI later).
 * @param {string} userId
 * @returns {string|null} hex fingerprint or null
 */
export function getLocalFingerprint(userId) {
  return readLocal(IDENTITY_KEY(userId))?.fingerprint ?? null;
}

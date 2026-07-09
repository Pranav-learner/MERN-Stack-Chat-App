/**
 * Client-side Trust integration (Layer 3, Sprint 3 — identity verification).
 *
 * Thin API client + local caching for user-to-user identity verification:
 * fingerprints, safety numbers, verification status, trust warnings, and QR
 * verification payloads. All values are PUBLIC; no private keys are involved and
 * no messages are encrypted here.
 *
 * QR: this module generates/parses the payload string only. Camera scanning is a
 * future concern — a scanner would hand a decoded string to {@link verifyViaQr}.
 */

const CACHE_VERSION = "v1";
const STATUS_CACHE_KEY = (userId, subjectId) => `securechat.trust.${CACHE_VERSION}.${userId}.${subjectId}`;
const WARNINGS_CACHE_KEY = (userId) => `securechat.trust.warnings.${CACHE_VERSION}.${userId}`;

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ value, at: new Date().toISOString() }));
  } catch {
    /* ignore storage errors */
  }
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).value : null;
  } catch {
    return null;
  }
}

/** Get another user's identity fingerprint (all formats). */
export async function getFingerprint(axios, userId) {
  const { data } = await axios.get(`/api/trust/users/${userId}/fingerprint`);
  return data?.fingerprint ?? null;
}

/** Get the symmetric safety number between the current user and `userId`. */
export async function getSafetyNumber(axios, userId) {
  const { data } = await axios.get(`/api/trust/users/${userId}/safety-number`);
  return data?.success ? { safetyNumber: data.safetyNumber, formatted: data.formatted, version: data.version } : null;
}

/**
 * Fetch (and cache) the verification status for a subject, including any trust
 * warnings (e.g. identity changed).
 */
export async function getVerificationStatus(axios, currentUserId, subjectUserId) {
  try {
    const { data } = await axios.get(`/api/trust/users/${subjectUserId}/status`);
    if (data?.success) {
      const snapshot = { state: data.state, verification: data.verification, warnings: data.warnings };
      writeCache(STATUS_CACHE_KEY(currentUserId, subjectUserId), snapshot);
      return snapshot;
    }
  } catch {
    /* fall through to cache */
  }
  return readCache(STATUS_CACHE_KEY(currentUserId, subjectUserId));
}

/**
 * Verify a subject's identity. Optionally pass the safety number the user
 * compared out-of-band; the server rejects a mismatch.
 */
export async function verifyIdentity(axios, subjectUserId, options = {}) {
  const { data } = await axios.post("/api/trust/verify", {
    subjectUserId,
    method: options.method,
    expectedSafetyNumber: options.expectedSafetyNumber,
    expectedFingerprint: options.expectedFingerprint,
  });
  return data?.verification ?? null;
}

/** Elevate a verified identity to trusted. */
export async function trustIdentity(axios, subjectUserId) {
  const { data } = await axios.post("/api/trust/trust", { subjectUserId });
  return data?.verification ?? null;
}

/** Revoke a verification. */
export async function untrustIdentity(axios, subjectUserId) {
  const { data } = await axios.post("/api/trust/untrust", { subjectUserId });
  return data?.verification ?? null;
}

/** List all of the current user's verifications. */
export async function listVerifications(axios) {
  const { data } = await axios.get("/api/trust/verifications");
  return data?.verifications ?? [];
}

/** Fetch (and cache) the current user's trust warnings (detected identity changes). */
export async function refreshTrustWarnings(axios, currentUserId) {
  try {
    const { data } = await axios.get("/api/trust/changes");
    if (data?.success) {
      writeCache(WARNINGS_CACHE_KEY(currentUserId), data.changes);
      return data.changes;
    }
  } catch {
    /* fall through */
  }
  return readCache(WARNINGS_CACHE_KEY(currentUserId)) ?? [];
}

/** Identity change history for a subject. */
export async function getIdentityHistory(axios, userId) {
  const { data } = await axios.get(`/api/trust/users/${userId}/history`);
  return data?.history ?? [];
}

// --- QR payloads ------------------------------------------------------------

/** Get the current user's own QR verification payload string (for others to scan). */
export async function getMyQrPayload(axios) {
  const { data } = await axios.get("/api/trust/me/qr");
  return data?.success ? { qr: data.qr, payload: data.payload } : null;
}

/** Get a QR verification payload string for another user. */
export async function getUserQrPayload(axios, userId) {
  const { data } = await axios.get(`/api/trust/users/${userId}/qr`);
  return data?.success ? { qr: data.qr, payload: data.payload } : null;
}

/**
 * Decode a scanned QR string into its payload object (client-side, for display).
 * Does NOT validate the checksum — the server validates on {@link verifyViaQr}.
 * @param {string} serialized base64url string from a QR scanner
 */
export function parseQrPayload(serialized) {
  const b64 = String(serialized).replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(b64)
      .split("")
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join(""),
  );
  return JSON.parse(json);
}

/**
 * Verify a subject by a scanned QR string (future scanner hands us the string).
 * The server validates the payload and confirms it matches the subject's current
 * identity before recording the verification.
 */
export async function verifyViaQr(axios, scannedString) {
  const { data } = await axios.post("/api/trust/verify-qr", { payload: scannedString });
  return data?.verification ?? null;
}

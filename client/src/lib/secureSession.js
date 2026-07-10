/**
 * Client Secure Session (Layer 4, Sprint 3).
 *
 * Turns the Sprint 2 shared secret (from `keyAgreement.js`) into a complete Secure
 * Session on the device: it derives the session keys locally with **Web Crypto
 * HKDF** — byte-for-byte identical to the server-side/reference derivation, so both
 * peers derive the SAME keys — keeps them in memory, and registers only PUBLIC
 * session METADATA (keyId, fingerprint, algorithm, length) with the server.
 *
 * @security Session keys and the shared secret NEVER leave the browser and are NEVER
 * written to localStorage. The server stores metadata only and cannot decrypt
 * anything. This module derives + stores session keys; it does NOT encrypt messages.
 */

import { loadSharedSecret } from "./keyAgreement.js";

const NAMESPACE = "securechat";
const DERIVATION_VERSION = 1;
const SESSION_KEY_ALGORITHM = "aes-256-gcm";
const SESSION_MAC_ALGORITHM = "hmac-sha256";
const KEY_BYTES = 32;

const KeyPurpose = {
  ENCRYPTION: "encryption",
  AUTHENTICATION: "authentication",
  INITIALIZATION: "initialization",
  RATCHET: "ratchet",
  RESUMPTION: "resumption",
  KEY_ID: "key-id",
};

/** In-memory session keys: sessionId -> { encryptionKey, macKey, ..., keyId, fingerprint }. Never persisted. */
const sessionKeys = new Map();

// === derivation (must match server shs/session/derivation/sessionKeys.js) ==

function buildContext({ handshakeId, participants, deviceIds, protocolVersion }) {
  const parties = [...(participants ?? [])].map(String).sort().join(",");
  const devices = deviceIds
    ? [deviceIds.initiator, deviceIds.responder].filter(Boolean).map(String).sort().join(",")
    : "";
  return `hs=${handshakeId}|parties=${parties}|devices=${devices}|pv=${protocolVersion ?? "1.0"}`;
}

function infoLabel(context, purpose, generation = 0) {
  return new TextEncoder().encode(
    `SHS-session-v${DERIVATION_VERSION}|ns=${NAMESPACE}|ctx=${context}|purpose=${purpose}|gen=${generation}`,
  );
}

async function hkdf(secretBytes, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function sha256Hex(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Derive the full session key set from a shared secret (device-local).
 * @param {Uint8Array} sharedSecret @param {object} context @param {number} [generation]
 * @returns {Promise<object>} session keys + public keyId/fingerprint
 */
export async function deriveSessionKeys(sharedSecret, context, generation = 0) {
  const ctx = buildContext(context);
  const salt = new TextEncoder().encode(`SHS-session-salt|${context.handshakeId}`);
  const encryptionKey = await hkdf(sharedSecret, salt, infoLabel(ctx, KeyPurpose.ENCRYPTION, generation), KEY_BYTES);
  const macKey = await hkdf(sharedSecret, salt, infoLabel(ctx, KeyPurpose.AUTHENTICATION, generation), KEY_BYTES);
  const initMaterial = await hkdf(sharedSecret, salt, infoLabel(ctx, KeyPurpose.INITIALIZATION, generation), 16);
  const ratchetMaterial = await hkdf(sharedSecret, salt, infoLabel(ctx, KeyPurpose.RATCHET, generation), KEY_BYTES);
  const resumptionKey = await hkdf(sharedSecret, salt, infoLabel(ctx, KeyPurpose.RESUMPTION, generation), KEY_BYTES);
  const keyIdBytes = await hkdf(sharedSecret, salt, infoLabel(ctx, KeyPurpose.KEY_ID, generation), 16);
  return {
    encryptionKey,
    macKey,
    initMaterial,
    ratchetMaterial,
    resumptionKey,
    keyId: toHex(keyIdBytes),
    keyFingerprint: await sha256Hex(encryptionKey, macKey),
    generation,
  };
}

// === establishment + registration =========================================

/**
 * Establish a Secure Session for a completed handshake: derive keys locally, store
 * them in memory, and register PUBLIC metadata with the server.
 *
 * @param {import("axios").AxiosInstance} axios
 * @param {string} handshakeId
 * @param {{ participants: string[], deviceIds?: object, protocolVersion?: string }} context
 * @returns {Promise<object>} the public session DTO from the server
 * @throws {Error} if no shared secret exists locally for the handshake
 */
export async function establishSession(axios, handshakeId, context) {
  const secret = loadSharedSecret(handshakeId);
  if (!secret) throw new Error("No local shared secret for this handshake — complete key agreement first");

  const keys = await deriveSessionKeys(secret, { handshakeId, ...context });
  const { data } = await axios.post("/api/secure-session/register", {
    handshakeId,
    encryptionKey: { algorithm: SESSION_KEY_ALGORITHM, length: KEY_BYTES, keyId: keys.keyId, fingerprint: keys.keyFingerprint },
    authenticationKey: { algorithm: SESSION_MAC_ALGORITHM, length: KEY_BYTES },
    protocolVersion: context.protocolVersion,
  });
  if (data?.success && data.session) {
    sessionKeys.set(data.session.sessionId, keys);
    return data.session;
  }
  return null;
}

/** The device-local session keys (for a FUTURE encryption layer). Never sent anywhere. */
export function loadSessionKeys(sessionId) {
  return sessionKeys.get(sessionId) ?? null;
}

/** The local key fingerprint for a session (safe to display/compare). */
export function getLocalKeyFingerprint(sessionId) {
  return sessionKeys.get(sessionId)?.keyFingerprint ?? null;
}

/** Wipe local key material for a session (call on close/destroy/logout). */
export function clearSessionKeys(sessionId) {
  const keys = sessionKeys.get(sessionId);
  if (keys) for (const f of ["encryptionKey", "macKey", "initMaterial", "ratchetMaterial", "resumptionKey"]) keys[f]?.fill?.(0);
  return sessionKeys.delete(sessionId);
}

/** Wipe ALL local session keys (call on logout). */
export function clearAll() {
  for (const id of [...sessionKeys.keys()]) clearSessionKeys(id);
}

// === server session awareness ==============================================

/** GET /api/secure-session — the caller's sessions (optionally filtered by status). */
export async function listSessions(axios, status) {
  const { data } = await axios.get("/api/secure-session", { params: status ? { status } : {} });
  return data?.sessions ?? [];
}

/** The caller's session history (all sessions, newest first). */
export async function getSessionHistory(axios) {
  return listSessions(axios);
}

/** GET the active session for a handshake, or null. */
export async function getCurrentSession(axios, handshakeId) {
  const { data } = await axios.get(`/api/secure-session/handshake/${handshakeId}`);
  return data?.session ?? null;
}

/** GET a single session's full status. */
export async function getSession(axios, sessionId) {
  const { data } = await axios.get(`/api/secure-session/${sessionId}`);
  return data?.session ?? null;
}

/** GET a session's compact status. */
export async function getSessionStatus(axios, sessionId) {
  const { data } = await axios.get(`/api/secure-session/${sessionId}/status`);
  return data?.status ?? null;
}

/** Resume an idle/paused session (metadata; keys are reused, not renegotiated). */
export async function resumeSession(axios, sessionId) {
  const { data } = await axios.post(`/api/secure-session/${sessionId}/resume`);
  return data?.session ?? null;
}

/** Record activity on a session (refreshes the idle clock). */
export async function trackActivity(axios, sessionId) {
  const { data } = await axios.post(`/api/secure-session/${sessionId}/activity`);
  return data?.session ?? null;
}

/** Close a session and wipe its local keys. */
export async function closeSession(axios, sessionId) {
  const { data } = await axios.post(`/api/secure-session/${sessionId}/close`);
  clearSessionKeys(sessionId);
  return data?.session ?? null;
}

/** Whether a session DTO is expired (client-side check against its `expiresAt`). */
export function isSessionExpired(session) {
  if (!session?.expiresAt) return false;
  return new Date(session.expiresAt).getTime() <= Date.now();
}

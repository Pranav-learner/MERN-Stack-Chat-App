/**
 * Client Secure Transport (Layer 4, Sprint 6 — end-to-end encryption).
 *
 * Encrypts messages IN THE BROWSER with the device-local session keys (Sprint 3) using
 * Web Crypto AES-256-GCM + encrypt-then-HMAC — byte-compatible with the server-side
 * reference (verified). The server only ever relays + stores the resulting ciphertext;
 * it cannot decrypt. This is the layer that finally makes messages confidential.
 *
 * ```
 * Application → Secure Transport (encrypt) → REST/WebSocket → relay → Secure Transport (decrypt) → Application
 * ```
 *
 * @security The plaintext and session keys never leave the browser. The `securePayload`
 * sent to the server contains ciphertext + authenticated metadata ONLY — no plaintext.
 * Encryption uses the EXISTING Sprint 3 session keys (`loadSessionKeys`); no forward
 * secrecy / ratchet here (Layer 5).
 */

import { loadSessionKeys } from "./secureSession.js";

const CIPHER = "aes-256-gcm";
const MAC = "hmac-sha256";
const ENVELOPE_VERSION = 1;
const PAYLOAD_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// === encoding helpers (match the server) ==================================

function toBase64(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Canonical AAD — MUST match server metadata.canonicalAAD exactly. */
function canonicalAAD(meta) {
  return enc.encode(
    [
      "SHS-transport-v1",
      meta.v,
      meta.payloadVersion,
      meta.type,
      meta.protocolVersion,
      meta.sessionId,
      meta.keyId,
      meta.senderDevice,
      meta.receiverDevice,
      meta.timestamp,
      meta.nonce,
    ].join("|"),
  );
}

function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hmac(macKeyBytes, ...parts) {
  const key = await crypto.subtle.importKey("raw", macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, concatBytes(...parts));
  return new Uint8Array(sig);
}

// === encrypt / decrypt ====================================================

/**
 * Encrypt an application message into a SecurePayload using session keys.
 * @param {object} message @param {{ encryptionKey: Uint8Array, macKey: Uint8Array, keyId: string }} keys
 * @param {{ sessionId: string, senderDevice?: string, receiverDevice?: string, type?: string }} context
 * @returns {Promise<object>} the SecurePayload (ciphertext only)
 */
export async function encryptMessage(message, keys, context) {
  const meta = {
    v: ENVELOPE_VERSION,
    payloadVersion: PAYLOAD_VERSION,
    type: context.type ?? "message",
    protocolVersion: context.protocolVersion ?? "1.0",
    sessionId: String(context.sessionId),
    keyId: String(keys.keyId),
    senderDevice: context.senderDevice ? String(context.senderDevice) : "",
    receiverDevice: context.receiverDevice ? String(context.receiverDevice) : "",
    timestamp: Date.now(),
    nonce: randomHex(16),
  };
  const aad = canonicalAAD(meta);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey("raw", keys.encryptionKey, "AES-GCM", false, ["encrypt"]);
  const plaintext = enc.encode(JSON.stringify(message ?? {}));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: TAG_BYTES * 8 }, key, plaintext),
  );
  // Web Crypto appends the tag; split it to match the server envelope.
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const mac = await hmac(keys.macKey, aad, iv, ciphertext, tag);

  return {
    ...meta,
    encryption: { algorithm: CIPHER, iv: toBase64(iv), ciphertext: toBase64(ciphertext), tag: toBase64(tag) },
    integrity: { algorithm: MAC, mac: toBase64(mac) },
    ratchet: null,
  };
}

/**
 * Decrypt a received SecurePayload back to the application message.
 * @param {object} payload @param {{ encryptionKey: Uint8Array, macKey: Uint8Array, keyId: string }} keys
 * @returns {Promise<object>} the plaintext message
 * @throws {Error} on integrity/decryption failure (wrong key, tamper, wrong session)
 */
export async function decryptMessage(payload, keys) {
  const { encryption, integrity, ratchet, ...meta } = payload;
  if (!encryption || !integrity) throw new Error("Malformed secure payload");
  if (meta.keyId !== keys.keyId) throw new Error("Payload encrypted under a different key generation");

  const aad = canonicalAAD(meta);
  const iv = fromBase64(encryption.iv);
  const ciphertext = fromBase64(encryption.ciphertext);
  const tag = fromBase64(encryption.tag);

  // Verify the outer HMAC first (constant-time-ish compare).
  const expectedMac = await hmac(keys.macKey, aad, iv, ciphertext, tag);
  const givenMac = fromBase64(integrity.mac);
  if (!timingSafeEqual(expectedMac, givenMac)) throw new Error("Integrity check failed (MAC)");

  const key = await crypto.subtle.importKey("raw", keys.encryptionKey, "AES-GCM", false, ["decrypt"]);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: TAG_BYTES * 8 },
      key,
      concatBytes(ciphertext, tag),
    );
  } catch {
    throw new Error("Integrity check failed (AEAD tag)");
  }
  return JSON.parse(dec.decode(plaintext));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// === high-level send / receive ============================================

/**
 * Encrypt + send a message end-to-end over REST. Requires an established Secure Session
 * for the peer (its `sessionId`). Falls back to the caller if no session/keys exist.
 *
 * @param {import("axios").AxiosInstance} axios @param {string} peerId
 * @param {object} message `{ text, image }`
 * @param {{ sessionId: string, senderDevice?: string, receiverDevice?: string }} session
 * @returns {Promise<{ message: object, encrypted: boolean }>}
 */
export async function sendEncrypted(axios, peerId, message, session) {
  const keys = loadSessionKeys(session.sessionId);
  if (!keys) throw new Error("No session keys — establish a secure session first");
  const securePayload = await encryptMessage(message, keys, {
    sessionId: session.sessionId,
    senderDevice: session.senderDevice,
    receiverDevice: session.receiverDevice,
  });
  const { data } = await axios.post(`/api/messages/send/${peerId}`, { securePayload, sessionId: session.sessionId });
  return { message: data?.message ?? null, encrypted: !!data?.encrypted };
}

/**
 * Decrypt an inbound stored/relayed message. Reconstructs the SecurePayload from the
 * message's `secure` subdoc and decrypts with the session keys.
 * @param {object} messageDoc a persisted/relayed message (with a `secure` block)
 * @returns {Promise<object|null>} the plaintext `{ text, image }`, or null if not encrypted
 */
export async function decryptIncoming(messageDoc) {
  const s = messageDoc?.secure;
  if (!s?.encrypted) return null;
  const keys = loadSessionKeys(s.sessionId);
  if (!keys) throw new Error("No session keys to decrypt this message");
  const payload = {
    v: s.v,
    payloadVersion: s.payloadVersion,
    type: s.type,
    protocolVersion: s.protocolVersion,
    sessionId: s.sessionId,
    keyId: s.keyId,
    senderDevice: s.senderDevice,
    receiverDevice: s.receiverDevice,
    timestamp: s.timestamp ?? (messageDoc.createdAt ? new Date(messageDoc.createdAt).getTime() : Date.now()),
    nonce: s.nonce,
    encryption: { algorithm: s.algorithm, iv: s.iv, ciphertext: s.ciphertext, tag: s.tag },
    integrity: { algorithm: s.macAlgorithm, mac: s.mac },
    ratchet: null,
  };
  return decryptMessage(payload, keys);
}

/** Whether the browser supports the crypto this layer needs. */
export async function isSupported() {
  try {
    return !!(crypto?.subtle && crypto.getRandomValues);
  } catch {
    return false;
  }
}

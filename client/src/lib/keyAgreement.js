/**
 * Client Secure Key Agreement (Layer 4, Sprint 2).
 *
 * Performs the DEVICE side of X25519 key agreement in the browser using the Web
 * Crypto API (the Node crypto SDK cannot run in a browser — same approach Layer 3
 * used for identity). The client:
 *
 *   1. generates a fresh ephemeral X25519 key pair (private key kept in memory,
 *      non-extractable),
 *   2. publishes only its PUBLIC ephemeral key to the relay,
 *   3. fetches the peer's PUBLIC ephemeral key and derives the shared secret LOCALLY,
 *   4. stores the secret as temporary in-memory session material,
 *   5. destroys the ephemeral private key, and publishes a one-way commitment so the
 *      relay can confirm both sides derived the same secret.
 *
 * @security The shared secret and the ephemeral private key NEVER leave the browser
 * and are NEVER written to localStorage. Temporary material lives in memory only and
 * should be cleared on logout. This module performs NO message encryption and derives
 * NO session encryption keys (a future sprint does).
 */

const ALGORITHM = "x25519";
const EPHEMERAL_KEY_VERSION = 1;
const COMMIT_LABEL = "SHS-KA-commit-v1"; // MUST match the server derivation module

/** In-memory ephemeral private keys: handshakeId -> CryptoKey (never persisted). */
const ephemeralPrivateKeys = new Map();
/** In-memory session material: handshakeId -> { secret: Uint8Array, fingerprint, algorithm, createdAt }. */
const sessionMaterial = new Map();

/** Whether this browser supports X25519 via Web Crypto. */
export async function isSupported() {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

// === encoding helpers =====================================================

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

async function sha256Hex(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Known X25519 small-order points (must be rejected as peer keys). Hex → bytes. */
const SMALL_ORDER_POINTS = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((h) => h.match(/.{2}/g).map((x) => parseInt(x, 16)));

function isSmallOrderPoint(raw) {
  if (raw.length !== 32) return false;
  const masked = Uint8Array.from(raw);
  masked[31] &= 0x7f;
  return SMALL_ORDER_POINTS.some((bad) => bad.every((b, i) => b === masked[i]));
}

// === local crypto =========================================================

/**
 * Generate a fresh ephemeral X25519 key pair; keep the private key in memory and
 * return the PUBLIC bundle to publish.
 * @param {string} handshakeId
 * @returns {Promise<{ algorithm: string, publicKey: string, keyId: string, version: number, createdAt: string }>}
 */
export async function generateEphemeralKeys(handshakeId) {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  ephemeralPrivateKeys.set(handshakeId, pair.privateKey);
  const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    algorithm: ALGORITHM,
    publicKey: toBase64(rawPub),
    keyId: crypto.randomUUID(),
    version: EPHEMERAL_KEY_VERSION,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Derive the shared secret against a peer's PUBLIC key, store temporary material,
 * destroy the ephemeral private key, and return the one-way commitment to publish.
 * @param {string} handshakeId @param {string} peerPublicKeyB64
 * @returns {Promise<{ fingerprint: string }>}
 * @throws {Error} on an invalid/unsafe peer key or a missing local ephemeral key
 */
export async function deriveSharedSecret(handshakeId, peerPublicKeyB64) {
  const priv = ephemeralPrivateKeys.get(handshakeId);
  if (!priv) throw new Error("No local ephemeral key for this handshake");

  const peerRaw = fromBase64(peerPublicKeyB64);
  if (peerRaw.length !== 32) throw new Error("Peer public key must be 32 bytes");
  if (isSmallOrderPoint(peerRaw)) throw new Error("Peer public key is a small-order point");

  const peerKey = await crypto.subtle.importKey("raw", peerRaw, { name: "X25519" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "X25519", public: peerKey }, priv, 256);
  const secret = new Uint8Array(bits);
  if (secret.every((b) => b === 0)) throw new Error("Derived an all-zero shared secret (unsafe peer key)");

  const fingerprint = await sha256Hex(new TextEncoder().encode(COMMIT_LABEL), secret);
  sessionMaterial.set(handshakeId, { secret, fingerprint, algorithm: ALGORITHM, createdAt: new Date().toISOString() });

  destroyEphemeralKeys(handshakeId); // ephemeral private key no longer needed
  return { fingerprint };
}

/** The device-local shared secret bytes (for a FUTURE sprint's KDF). Never sent anywhere. */
export function loadSharedSecret(handshakeId) {
  return sessionMaterial.get(handshakeId)?.secret ?? null;
}

/** Public view of local session material (fingerprint only — never the secret). */
export function getLocalMaterial(handshakeId) {
  const m = sessionMaterial.get(handshakeId);
  return m ? { handshakeId, sharedSecretFingerprint: m.fingerprint, algorithm: m.algorithm, createdAt: m.createdAt } : null;
}

/** Destroy the in-memory ephemeral private key for a handshake. */
export function destroyEphemeralKeys(handshakeId) {
  return ephemeralPrivateKeys.delete(handshakeId);
}

/** Zero + clear the temporary session material for a handshake (call on logout / after use). */
export function clearSessionMaterial(handshakeId) {
  const m = sessionMaterial.get(handshakeId);
  if (m?.secret) m.secret.fill(0);
  return sessionMaterial.delete(handshakeId);
}

/** Clear ALL in-memory key-agreement material (call on logout). */
export function clearAll() {
  for (const m of sessionMaterial.values()) m.secret?.fill(0);
  sessionMaterial.clear();
  ephemeralPrivateKeys.clear();
}

// === relay API ============================================================

/** GET /api/key-agreement/capabilities */
export async function getCapabilities(axios) {
  const { data } = await axios.get("/api/key-agreement/capabilities");
  return data?.capabilities ?? null;
}

/** POST /api/key-agreement/:id/negotiate */
export async function negotiateKeyAgreement(axios, handshakeId, offers = {}) {
  const { data } = await axios.post(`/api/key-agreement/${handshakeId}/negotiate`, {
    initiatorOffer: offers.initiatorOffer ?? { algorithms: [ALGORITHM] },
    responderOffer: offers.responderOffer ?? { algorithms: [ALGORITHM] },
  });
  return data?.exchange ?? null;
}

/** POST /api/key-agreement/:id/keys */
export async function submitEphemeralKey(axios, handshakeId, bundle) {
  const { data } = await axios.post(`/api/key-agreement/${handshakeId}/keys`, { ephemeralKey: bundle });
  return data?.exchange ?? null;
}

/** GET /api/key-agreement/:id/peer-key */
export async function fetchPeerKey(axios, handshakeId) {
  const { data } = await axios.get(`/api/key-agreement/${handshakeId}/peer-key`);
  return data?.peerKey ?? null;
}

/** POST /api/key-agreement/:id/commitment */
export async function submitCommitment(axios, handshakeId, commitment) {
  const { data } = await axios.post(`/api/key-agreement/${handshakeId}/commitment`, { commitment });
  return data?.exchange ?? null;
}

/** GET /api/key-agreement/:id */
export async function getExchangeStatus(axios, handshakeId) {
  const { data } = await axios.get(`/api/key-agreement/${handshakeId}`);
  return data?.exchange ?? null;
}

/**
 * Run the full DEVICE side of key agreement once a handshake is negotiated:
 * generate → publish key → wait for peer key → derive locally → publish commitment.
 *
 * @param {import("axios").AxiosInstance} axios @param {string} handshakeId
 * @param {{ initiate?: boolean, pollMs?: number, maxAttempts?: number, offers?: object }} [options]
 *   `initiate: true` also calls negotiate first (the initiator does this).
 * @returns {Promise<{ fingerprint: string, exchange: object }>}
 */
export async function performKeyAgreement(axios, handshakeId, options = {}) {
  if (options.initiate) await negotiateKeyAgreement(axios, handshakeId, { ...options.offers });

  const bundle = await generateEphemeralKeys(handshakeId);
  await submitEphemeralKey(axios, handshakeId, bundle);

  const peerKey = await waitForPeerKey(axios, handshakeId, options.pollMs ?? 1000, options.maxAttempts ?? 30);
  const { fingerprint } = await deriveSharedSecret(handshakeId, peerKey.publicKey);
  const exchange = await submitCommitment(axios, handshakeId, fingerprint);
  return { fingerprint, exchange };
}

/** Poll the relay until the peer's ephemeral public key is available. */
async function waitForPeerKey(axios, handshakeId, pollMs, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    const peerKey = await fetchPeerKey(axios, handshakeId);
    if (peerKey) return peerKey;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Timed out waiting for the peer's ephemeral key");
}

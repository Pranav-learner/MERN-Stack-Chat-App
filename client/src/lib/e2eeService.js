/**
 * @module lib/e2eeService
 *
 * Client-Side End-to-End Encryption Service (Milestone 1 — E2EE for Direct Messages).
 *
 * Implements browser-native WebCrypto (ECDH P-256 + HKDF-SHA256 + AES-256-GCM + HMAC-SHA256).
 *
 * Invariants:
 * 1. Plaintext messages are encrypted ON-DEVICE before leaving the browser.
 * 2. The server acts as a blind relay: it validates the envelope shape, but receives and stores
 *    only opaque ciphertext (text and image fields remain undefined in MongoDB).
 * 3. The recipient decrypts the ciphertext ON-DEVICE with their private key and peer's public key.
 * 4. Tampering with ciphertext, IV, AAD metadata, or authentication tag causes immediate
 *    cryptographic rejection (Integrity check failure).
 */

const STORAGE_VERSION = "v1";
const E2EE_KEY = (userId) => `securechat.e2ee.${STORAGE_VERSION}.${userId}`;

const enc = new TextEncoder();
const dec = new TextDecoder();

// In-memory cache for derived pairwise session keys: sessionId -> sessionKeyMaterial
const sessionCache = new Map();

// --- Helpers -----------------------------------------------------------------

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

function randomHex(bytesCount = 16) {
  const buf = new Uint8Array(bytesCount);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Canonical AAD - Matches server canonical AAD order exactly */
function buildCanonicalAAD(meta) {
  const canon = [
    "SHS-transport-v1",
    meta.v,
    meta.payloadVersion,
    meta.type,
    meta.protocolVersion,
    meta.sessionId,
    meta.keyId,
    meta.senderDevice || "",
    meta.receiverDevice || "",
    meta.timestamp,
    meta.nonce,
  ].join("|");
  return enc.encode(canon);
}

// --- Local Key Management ----------------------------------------------------

/**
 * Get or generate the user's local ECDH keypair.
 * The private key stays in localStorage/memory; public key is shared for key agreement.
 */
export async function getOrCreateE2EEKeyPair(userId) {
  if (!userId) return null;
  const storageKey = E2EE_KEY(userId);

  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const record = JSON.parse(raw);
      if (record && record.publicKey && record.privateKeyJwk) {
        const privateKey = await crypto.subtle.importKey(
          "jwk",
          record.privateKeyJwk,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"]
        );
        return {
          publicKey: record.publicKey,
          privateKey,
        };
      }
    }
  } catch (err) {
    console.warn("[e2ee] Failed to load local keypair, re-generating:", err);
  }

  // Generate fresh ECDH keypair
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKey = toBase64(rawPub);

  try {
    localStorage.setItem(storageKey, JSON.stringify({ publicKey, privateKeyJwk }));
  } catch (storageErr) {
    console.error("[e2ee] Failed to cache local keypair in localStorage:", storageErr);
  }

  return { publicKey, privateKey: keyPair.privateKey };
}

/**
 * Ensure the local user's E2EE public key is published on the backend user profile.
 */
export async function ensurePublicKeyPublished(axios, userId, currentUser) {
  try {
    const keyPair = await getOrCreateE2EEKeyPair(userId);
    if (!keyPair) return null;

    if (!currentUser?.publicKey || currentUser.publicKey !== keyPair.publicKey) {
      await axios.put("/api/auth/update-profile", { publicKey: keyPair.publicKey });
    }
    return keyPair.publicKey;
  } catch (error) {
    console.warn("[e2ee] Failed to publish public key:", error?.message);
    return null;
  }
}

// --- Pairwise Key Derivation -------------------------------------------------

/**
 * Derive shared session keys between current user and peer using ECDH + HKDF.
 */
export async function getOrDeriveSession(myUserId, peerUser) {
  if (!myUserId || !peerUser || !peerUser._id) return null;
  const peerId = String(peerUser._id);
  const myId = String(myUserId);
  const sessionId = "e2ee_" + [myId, peerId].sort().join("_");

  if (sessionCache.has(sessionId)) {
    return sessionCache.get(sessionId);
  }

  const peerPublicKeyB64 = peerUser.publicKey;
  if (!peerPublicKeyB64) {
    return null; // Peer has not yet registered an E2EE public key
  }

  const myKeyPair = await getOrCreateE2EEKeyPair(myId);
  if (!myKeyPair) return null;

  // Import peer public key
  const peerRaw = fromBase64(peerPublicKeyB64);
  const peerKey = await crypto.subtle.importKey(
    "raw",
    peerRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // Compute ECDH shared secret (256 bits)
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    myKeyPair.privateKey,
    256
  );

  // Derive AES-256-GCM encryption key and HMAC-SHA256 authentication key via HKDF
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const salt = enc.encode(`chat-app-e2ee-salt-${sessionId}`);
  const encKeyBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("aes-256-gcm-encryption") },
    hkdfKey,
    256
  );
  const macKeyBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("hmac-sha256-mac") },
    hkdfKey,
    256
  );

  const digest = await crypto.subtle.digest("SHA-256", encKeyBits);
  const keyId = bytesToHex(new Uint8Array(digest)).slice(0, 16);

  const session = {
    sessionId,
    keyId,
    encKeyBits: new Uint8Array(encKeyBits),
    macKeyBits: new Uint8Array(macKeyBits),
  };

  sessionCache.set(sessionId, session);
  return session;
}

// --- Encrypt & Decrypt -------------------------------------------------------

/**
 * Encrypt a direct message payload for a recipient user.
 */
export async function encryptDirectMessage(peerUser, messagePayload, myUserId) {
  const session = await getOrDeriveSession(myUserId, peerUser);
  if (!session) {
    return null; // Cannot encrypt; fall back to unencrypted or caller handles
  }

  const meta = {
    v: 1,
    payloadVersion: 1,
    type: "message",
    protocolVersion: "1.0",
    sessionId: session.sessionId,
    keyId: session.keyId,
    senderDevice: "web-client",
    receiverDevice: "",
    timestamp: Date.now(),
    nonce: randomHex(16),
  };

  const aad = buildCanonicalAAD(meta);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const aesKey = await crypto.subtle.importKey("raw", session.encKeyBits, "AES-GCM", false, ["encrypt"]);
  const plaintext = enc.encode(JSON.stringify(messagePayload || {}));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      plaintext
    )
  );

  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  // Encrypt-then-MAC: HMAC over AAD || IV || Ciphertext || Tag
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    session.macKeyBits,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const hmacInput = concatBytes(aad, iv, ciphertext, tag);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, hmacInput));

  const securePayload = {
    ...meta,
    encryption: {
      algorithm: "aes-256-gcm",
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
      tag: toBase64(tag),
    },
    integrity: {
      algorithm: "hmac-sha256",
      mac: toBase64(mac),
    },
    ratchet: null,
  };

  return {
    securePayload,
    sessionId: session.sessionId,
  };
}

/**
 * Decrypt an incoming message document if encrypted.
 */
export async function decryptDirectMessage(messageDoc, myUserId, peerUser) {
  if (!messageDoc?.secure?.encrypted) {
    // Unencrypted legacy message
    return {
      text: messageDoc?.text,
      image: messageDoc?.image,
      isEncrypted: false,
    };
  }

  const session = await getOrDeriveSession(myUserId, peerUser);
  if (!session) {
    return {
      text: "🔒 [End-to-End Encrypted Message - Waiting for peer key exchange]",
      image: null,
      isEncrypted: true,
      pendingKey: true,
    };
  }

  const s = messageDoc.secure;

  try {
    const meta = {
      v: s.v || 1,
      payloadVersion: s.payloadVersion || 1,
      type: s.type || "message",
      protocolVersion: s.protocolVersion || "1.0",
      sessionId: s.sessionId,
      keyId: s.keyId,
      senderDevice: s.senderDevice || "",
      receiverDevice: s.receiverDevice || "",
      timestamp: s.timestamp || (messageDoc.createdAt ? new Date(messageDoc.createdAt).getTime() : Date.now()),
      nonce: s.nonce,
    };

    const aad = buildCanonicalAAD(meta);
    const iv = fromBase64(s.iv);
    const ciphertext = fromBase64(s.ciphertext);
    const tag = fromBase64(s.tag);
    const givenMac = fromBase64(s.mac);

    // 1. Verify HMAC
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      session.macKeyBits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmacInput = concatBytes(aad, iv, ciphertext, tag);
    const expectedMac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, hmacInput));

    if (!timingSafeEqual(expectedMac, givenMac)) {
      throw new Error("Integrity check failed: HMAC mismatch");
    }

    // 2. Decrypt AES-GCM
    const aesKey = await crypto.subtle.importKey("raw", session.encKeyBits, "AES-GCM", false, ["decrypt"]);
    const combined = concatBytes(ciphertext, tag);
    const decryptedBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      combined
    );

    const decrypted = JSON.parse(dec.decode(decryptedBytes));
    return {
      text: decrypted.text || "",
      image: decrypted.image || null,
      media: decrypted.media || null,
      isEncrypted: true,
    };
  } catch (error) {
    console.error("[e2ee] Decryption failure:", error.message);
    return {
      text: "⚠️ [Decryption Failed: Message tampered or corrupted]",
      image: null,
      media: null,
      isEncrypted: true,
      failed: true,
    };
  }
}

// --- Milestone 2: Secure Media Platform Integration --------------------------

const mediaCache = new Map();

export function cacheMediaUrl(mediaId, url) {
  if (mediaId && url) {
    mediaCache.set(String(mediaId), url);
  }
}

export function getCachedMediaUrl(mediaId) {
  return mediaCache.get(String(mediaId)) || null;
}

/**
 * Encrypt a media File/Blob client-side using a fresh random 256-bit media key (AES-256-GCM).
 */
export async function encryptMediaFile(file) {
  const plainBytes = new Uint8Array(await file.arrayBuffer());
  const mediaKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 1. Plaintext SHA-256 hash
  const hashBuf = await crypto.subtle.digest("SHA-256", plainBytes);
  const plaintextHash = bytesToHex(new Uint8Array(hashBuf));

  // 2. Media key fingerprint (SHA-256 of key)
  const keyHashBuf = await crypto.subtle.digest("SHA-256", mediaKey);
  const keyFingerprint = bytesToHex(new Uint8Array(keyHashBuf));

  // 3. Encrypt with AES-GCM
  const aesKey = await crypto.subtle.importKey("raw", mediaKey, "AES-GCM", false, ["encrypt"]);
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    plainBytes
  );

  const encryptedBytes = new Uint8Array(encryptedBuf);
  const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.subarray(encryptedBytes.length - 16);

  return {
    mediaKeyB64: toBase64(mediaKey),
    keyFingerprint,
    ivB64: toBase64(iv),
    ciphertextB64: toBase64(ciphertext),
    authTagB64: toBase64(authTag),
    plaintextHash,
    plaintextSize: plainBytes.length,
    filename: file.name || "image.png",
    contentType: file.type || "image/png",
  };
}

/**
 * Upload opaque encrypted media ciphertext to the server's blind relay (/api/media).
 */
export async function uploadEncryptedMedia(axios, encryptedData, conversationId) {
  const payload = {
    filename: encryptedData.filename,
    contentType: encryptedData.contentType,
    ciphertext: encryptedData.ciphertextB64,
    plaintextHash: encryptedData.plaintextHash,
    plaintextSize: encryptedData.plaintextSize,
    encryption: {
      keyFingerprint: encryptedData.keyFingerprint,
      iv: encryptedData.ivB64,
      authTag: encryptedData.authTagB64,
    },
    conversationId: conversationId ? String(conversationId) : undefined,
  };

  const { data } = await axios.post("/api/media", payload);
  if (!data.success || !data.media?.mediaId) {
    throw new Error(data.message || "Failed to upload encrypted media");
  }
  return data.media;
}

/**
 * Decrypt an opaque media download payload with the recipient's decrypted mediaKey.
 */
export async function decryptMediaBlob(downloadPayload, mediaKeyB64) {
  const mediaKey = fromBase64(mediaKeyB64);
  const ciphertext = fromBase64(downloadPayload.ciphertext);
  const iv = fromBase64(downloadPayload.encryption.iv);
  const authTag = fromBase64(downloadPayload.encryption.authTag);

  const aesKey = await crypto.subtle.importKey("raw", mediaKey, "AES-GCM", false, ["decrypt"]);
  const combined = concatBytes(ciphertext, authTag);

  const decryptedBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    combined
  );

  const decryptedBytes = new Uint8Array(decryptedBuf);

  // Verify plaintext SHA-256 integrity
  if (downloadPayload.plaintextHash) {
    const hashBuf = await crypto.subtle.digest("SHA-256", decryptedBytes);
    const calculatedHash = bytesToHex(new Uint8Array(hashBuf));
    if (calculatedHash !== downloadPayload.plaintextHash) {
      throw new Error("Media integrity check failed: Plaintext SHA-256 mismatch");
    }
  }

  const blob = new Blob([decryptedBytes], { type: downloadPayload.contentType || "image/png" });
  return URL.createObjectURL(blob);
}

/**
 * Fetch opaque ciphertext from /api/media/:mediaId/download and decrypt it locally.
 */
export async function fetchAndDecryptMedia(axios, mediaMeta) {
  if (!mediaMeta?.mediaId || !mediaMeta?.mediaKey) return null;

  const cached = getCachedMediaUrl(mediaMeta.mediaId);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`/api/media/${mediaMeta.mediaId}/download`);
    if (!data.success || !data.download) {
      throw new Error("Failed to download media ciphertext");
    }

    const blobUrl = await decryptMediaBlob(data.download, mediaMeta.mediaKey);
    cacheMediaUrl(mediaMeta.mediaId, blobUrl);
    return blobUrl;
  } catch (error) {
    console.error("[e2ee] Failed to fetch/decrypt media:", error);
    return null;
  }
}

/**
 * Decrypt a list of messages for the active conversation, resolving encrypted media.
 */
export async function decryptMessageList(messages, myUserId, peerUser, axiosInstance = null) {
  if (!Array.isArray(messages)) return [];
  const results = [];
  for (const msg of messages) {
    if (msg.secure?.encrypted) {
      const decrypted = await decryptDirectMessage(msg, myUserId, peerUser);
      let resolvedImage = decrypted.image;

      // If message carries an E2EE media reference, download and decrypt it
      if (!resolvedImage && decrypted.media && axiosInstance) {
        resolvedImage = await fetchAndDecryptMedia(axiosInstance, decrypted.media);
      }

      results.push({
        ...msg,
        text: decrypted.text,
        image: resolvedImage,
        media: decrypted.media,
        isEncrypted: decrypted.isEncrypted,
        failed: decrypted.failed,
      });
    } else {
      results.push({
        ...msg,
        isEncrypted: false,
      });
    }
  }
  return results;
}

// --- Milestone 3: Group Chat End-to-End Encryption (Group Keys) --------------

const groupKeyCache = new Map(); // groupId -> { groupKeyBytes, epoch }

export function clearGroupKeyCache(groupId) {
  if (groupId) {
    groupKeyCache.delete(String(groupId));
  } else {
    groupKeyCache.clear();
  }
}

/**
 * Derive group-specific AES and MAC keys from raw group key bytes via HKDF.
 */
async function deriveGroupSubkeys(groupKeyBytes, groupId) {
  const salt = enc.encode(`MERN-Group-Salt-v1:${groupId}`);
  const info = enc.encode(`Group-E2EE-Subkeys-v1:${groupId}`);

  const hkdfKey = await crypto.subtle.importKey("raw", groupKeyBytes, "HKDF", false, ["deriveBits"]);
  const derivedBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      hkdfKey,
      64 * 8
    )
  );

  return {
    encKeyBytes: derivedBytes.slice(0, 32),
    macKeyBytes: derivedBytes.slice(32, 64),
  };
}

/**
 * Retrieve or establish the shared group symmetric key for a group.
 */
export async function getOrEstablishGroupKey(groupId, group, myUserId, axios) {
  if (!groupId || !myUserId) return null;
  const gid = String(groupId);

  if (groupKeyCache.has(gid)) {
    return groupKeyCache.get(gid);
  }

  // Check localStorage cache
  const localKey = `securechat.groupkey.v1.${gid}`;
  try {
    const cachedStr = localStorage.getItem(localKey);
    if (cachedStr) {
      const parsed = JSON.parse(cachedStr);
      if (parsed.keyB64) {
        const item = { groupKeyBytes: fromBase64(parsed.keyB64), epoch: parsed.epoch || 1 };
        groupKeyCache.set(gid, item);
        return item;
      }
    }
  } catch {}

  // Fetch group key records from backend
  let groupE2ee = group?.e2ee;
  if (!groupE2ee?.encryptedKeys || groupE2ee.encryptedKeys.length === 0) {
    try {
      const { data } = await axios.get(`/api/groups/${gid}/keys`);
      if (data.success && data.e2ee) {
        groupE2ee = data.e2ee;
      }
    } catch (err) {
      console.warn("[e2ee] Failed to fetch group keys:", err?.message);
    }
  }

  // Look for our encrypted group key
  const myKeyRecord = groupE2ee?.encryptedKeys?.find(
    (k) => String(k.userId?._id || k.userId) === String(myUserId)
  );

  if (myKeyRecord) {
    try {
      const senderId = String(myKeyRecord.senderId?._id || myKeyRecord.senderId);
      const senderUser = group?.members?.find((m) => String(m._id) === senderId) || { _id: senderId };

      const session = await getOrDeriveSession(myUserId, senderUser);
      if (session) {
        const aesKey = await crypto.subtle.importKey("raw", session.encKeyBits, "AES-GCM", false, ["decrypt"]);
        const combined = concatBytes(fromBase64(myKeyRecord.encryptedKey), fromBase64(myKeyRecord.tag));
        const decryptedKeyBuf = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64(myKeyRecord.iv), tagLength: 128 },
          aesKey,
          combined
        );

        const groupKeyBytes = new Uint8Array(decryptedKeyBuf);
        const item = { groupKeyBytes, epoch: myKeyRecord.epoch || 1 };
        groupKeyCache.set(gid, item);
        try {
          localStorage.setItem(localKey, JSON.stringify({ keyB64: toBase64(groupKeyBytes), epoch: item.epoch }));
        } catch {}
        return item;
      }
    } catch (decryptErr) {
      console.error("[e2ee] Failed to decrypt group key record:", decryptErr);
    }
  }

  // If no record exists, establish a fresh group key
  try {
    const rawGroupKey = crypto.getRandomValues(new Uint8Array(32));
    const keyHashBuf = await crypto.subtle.digest("SHA-256", rawGroupKey);
    const keyFingerprint = bytesToHex(new Uint8Array(keyHashBuf));

    const encryptedKeys = [];
    const members = Array.isArray(group?.members) ? group.members : [];

    for (const member of members) {
      const memberId = String(member._id || member);
      const memberObj = typeof member === "object" ? member : { _id: memberId };

      try {
        const session = await getOrDeriveSession(myUserId, memberObj);
        if (session) {
          const aesKey = await crypto.subtle.importKey("raw", session.encKeyBits, "AES-GCM", false, ["encrypt"]);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encryptedBuf = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: 128 },
            aesKey,
            rawGroupKey
          );

          const encryptedBytes = new Uint8Array(encryptedBuf);
          const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - 16);
          const tag = encryptedBytes.subarray(encryptedBytes.length - 16);

          encryptedKeys.push({
            userId: memberId,
            encryptedKey: toBase64(ciphertext),
            iv: toBase64(iv),
            tag: toBase64(tag),
            senderId: myUserId,
            epoch: 1,
          });
        }
      } catch (encMemberErr) {
        console.warn(`[e2ee] Failed to encrypt group key for member ${memberId}:`, encMemberErr);
      }
    }

    if (encryptedKeys.length > 0) {
      await axios.post(`/api/groups/${gid}/keys`, {
        epoch: 1,
        keyFingerprint,
        encryptedKeys,
      });
    }

    const item = { groupKeyBytes: rawGroupKey, epoch: 1 };
    groupKeyCache.set(gid, item);
    try {
      localStorage.setItem(localKey, JSON.stringify({ keyB64: toBase64(rawGroupKey), epoch: 1 }));
    } catch {}
    return item;
  } catch (estErr) {
    console.error("[e2ee] Failed to establish fresh group key:", estErr);
    return null;
  }
}

/**
 * Encrypt a group message using the group's symmetric key.
 */
export async function encryptGroupMessage(groupId, messagePayload, myUserId, group, axios) {
  const groupKeyRecord = await getOrEstablishGroupKey(groupId, group, myUserId, axios);
  if (!groupKeyRecord?.groupKeyBytes) {
    return null;
  }

  const { encKeyBytes, macKeyBytes } = await deriveGroupSubkeys(groupKeyRecord.groupKeyBytes, groupId);

  const meta = {
    v: 1,
    payloadVersion: 1,
    type: "message",
    protocolVersion: "1.0",
    sessionId: `grp_${groupId}_ep${groupKeyRecord.epoch}`,
    keyId: `grpkey_${groupId}`,
    senderDevice: "web-client",
    receiverDevice: "",
    timestamp: Date.now(),
    nonce: randomHex(16),
  };

  const aad = buildCanonicalAAD(meta);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const aesKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["encrypt"]);
  const plaintext = enc.encode(JSON.stringify(messagePayload || {}));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      plaintext
    )
  );

  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  // Encrypt-then-MAC
  const hmacKey = await crypto.subtle.importKey("raw", macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hmacInput = concatBytes(aad, iv, ciphertext, tag);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, hmacInput));

  const securePayload = {
    ...meta,
    encryption: {
      algorithm: "aes-256-gcm",
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
      tag: toBase64(tag),
    },
    integrity: {
      algorithm: "hmac-sha256",
      mac: toBase64(mac),
    },
    ratchet: null,
  };

  return {
    securePayload,
    sessionId: meta.sessionId,
  };
}

/**
 * Decrypt an incoming group message.
 */
export async function decryptGroupMessage(messageDoc, myUserId, group, axios) {
  if (!messageDoc?.secure?.encrypted) {
    return {
      text: messageDoc?.text,
      image: messageDoc?.image,
      media: messageDoc?.media,
      isEncrypted: false,
    };
  }

  const groupId = messageDoc.groupId?._id || messageDoc.groupId;
  const groupKeyRecord = await getOrEstablishGroupKey(groupId, group, myUserId, axios);

  if (!groupKeyRecord?.groupKeyBytes) {
    return {
      text: "🔒 [End-to-End Encrypted Group Message - Waiting for key exchange]",
      image: null,
      media: null,
      isEncrypted: true,
      pendingKey: true,
    };
  }

  const s = messageDoc.secure;

  try {
    const { encKeyBytes, macKeyBytes } = await deriveGroupSubkeys(groupKeyRecord.groupKeyBytes, groupId);

    const meta = {
      v: s.v || 1,
      payloadVersion: s.payloadVersion || 1,
      type: s.type || "message",
      protocolVersion: s.protocolVersion || "1.0",
      sessionId: s.sessionId,
      keyId: s.keyId,
      senderDevice: s.senderDevice || "",
      receiverDevice: s.receiverDevice || "",
      timestamp: s.timestamp || (messageDoc.createdAt ? new Date(messageDoc.createdAt).getTime() : Date.now()),
      nonce: s.nonce,
    };

    const aad = buildCanonicalAAD(meta);
    const iv = fromBase64(s.iv);
    const ciphertext = fromBase64(s.ciphertext);
    const tag = fromBase64(s.tag);
    const givenMac = fromBase64(s.mac);

    // 1. Verify HMAC
    const hmacKey = await crypto.subtle.importKey("raw", macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hmacInput = concatBytes(aad, iv, ciphertext, tag);
    const expectedMac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, hmacInput));

    if (!timingSafeEqual(expectedMac, givenMac)) {
      throw new Error("Group message integrity check failed: HMAC mismatch");
    }

    // 2. Decrypt AES-GCM
    const aesKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["decrypt"]);
    const combined = concatBytes(ciphertext, tag);
    const decryptedBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      combined
    );

    const decrypted = JSON.parse(dec.decode(decryptedBytes));
    return {
      text: decrypted.text || "",
      image: decrypted.image || null,
      media: decrypted.media || null,
      isEncrypted: true,
    };
  } catch (error) {
    console.error("[e2ee] Group decryption failure:", error.message);
    return {
      text: "⚠️ [Decryption Failed: Group message corrupted]",
      image: null,
      media: null,
      isEncrypted: true,
      failed: true,
    };
  }
}

/**
 * Decrypt a list of group messages, resolving any attached secure media.
 */
export async function decryptGroupMessageList(messages, myUserId, group, axiosInstance = null) {
  if (!Array.isArray(messages)) return [];
  const results = [];
  for (const msg of messages) {
    if (msg.secure?.encrypted) {
      const decrypted = await decryptGroupMessage(msg, myUserId, group, axiosInstance);
      let resolvedImage = decrypted.image;

      if (!resolvedImage && decrypted.media && axiosInstance) {
        resolvedImage = await fetchAndDecryptMedia(axiosInstance, decrypted.media);
      }

      results.push({
        ...msg,
        text: decrypted.text,
        image: resolvedImage,
        media: decrypted.media,
        isEncrypted: decrypted.isEncrypted,
        failed: decrypted.failed,
      });
    } else {
      results.push({
        ...msg,
        isEncrypted: false,
      });
    }
  }
  return results;
}


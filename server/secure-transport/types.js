/**
 * @module secure-transport/types
 *
 * Enums and type declarations for the **Secure Transport Layer** (Layer 4, Sprint 6 —
 * first end-to-end encrypted communication). This layer owns ALL secure communication
 * between devices: encryption, decryption, serialization, secure-payload construction,
 * session usage, and transport abstraction. The application never encrypts directly.
 *
 * @security This layer performs REAL encryption using the Sprint 3 session keys
 * (AES-256-GCM + encrypt-then-HMAC). It runs on the DEVICE (client / reference /
 * tests) where keys live. The server only ever sees ciphertext + metadata — it cannot
 * decrypt. No plaintext, key, or shared secret is ever stored or transmitted in the
 * clear.
 */

/** The AEAD cipher (the Layer 2 Crypto SDK's SymmetricEngine primitive). */
export const CIPHER_ALGORITHM = "aes-256-gcm";
/** The integrity MAC over the encrypted envelope (encrypt-then-MAC). */
export const MAC_ALGORITHM = "hmac-sha256";
/** Secure-payload envelope version. */
export const PAYLOAD_ENVELOPE_VERSION = 1;
/** Inner payload schema version. */
export const PAYLOAD_VERSION = 1;
/** AES-GCM IV length (bytes) — 96-bit nonce per NIST SP 800-38D. */
export const IV_BYTES = 12;
/** AES-GCM authentication tag length (bytes). */
export const TAG_BYTES = 16;

/**
 * Secure message types the transport carries. Content messages are ENCRYPTED;
 * operational/protocol messages may travel unencrypted (see the WebSocket design in
 * the docs).
 * @readonly @enum {string}
 */
export const MessageType = Object.freeze({
  MESSAGE: "message",
  EDIT: "edit",
  REPLY: "reply",
  FORWARD: "forward",
  DELETE: "delete",
  REACTION: "reaction",
});

/** All content message types (always encrypted). */
export const ENCRYPTED_MESSAGE_TYPES = Object.freeze(Object.values(MessageType));

/**
 * Operational (control-plane) events that are NOT message content. These may travel
 * unencrypted — they carry no message body, only routing/status metadata.
 * @readonly @enum {string}
 */
export const OperationalType = Object.freeze({
  TYPING: "typing",
  PRESENCE: "presence",
  READ_RECEIPT: "read-receipt",
  DELIVERY_STATUS: "delivery-status",
});

/** Secure-transport event types. @readonly @enum {string} */
export const SecureTransportEventType = Object.freeze({
  MESSAGE_ENCRYPTED: "transport.message_encrypted",
  MESSAGE_DECRYPTED: "transport.message_decrypted",
  INTEGRITY_FAILURE: "transport.integrity_failure",
  DECRYPTION_FAILURE: "transport.decryption_failure",
  MALFORMED_PAYLOAD: "transport.malformed_payload",
  RELAYED: "transport.relayed",
  TRANSPORT_SENT: "transport.sent",
  TRANSPORT_RECEIVED: "transport.received",
});

/** Machine-readable failure reasons. @readonly @enum {string} */
export const TransportFailureReason = Object.freeze({
  MALFORMED_PAYLOAD: "malformed-payload",
  WRONG_SESSION: "wrong-session",
  WRONG_DEVICE: "wrong-device",
  WRONG_IDENTITY: "wrong-identity",
  CORRUPTED_CIPHERTEXT: "corrupted-ciphertext",
  VERSION_MISMATCH: "version-mismatch",
  INTEGRITY_FAILURE: "integrity-failure",
  REPLAY: "replay",
  MISSING_KEYS: "missing-keys",
});

/**
 * @typedef {object} SecurePayload The on-the-wire encrypted envelope. Contains NO
 * plaintext. All binary fields are base64.
 * @property {number} v envelope version ({@link PAYLOAD_ENVELOPE_VERSION})
 * @property {number} payloadVersion inner payload schema version
 * @property {string} type one of {@link MessageType}
 * @property {string} protocolVersion SHS protocol version
 * @property {string} sessionId the Secure Session this was encrypted under
 * @property {string} keyId the session encryption-key id (metadata; not the key)
 * @property {string} senderDevice @property {string} receiverDevice device ids
 * @property {number} timestamp epoch ms
 * @property {string} nonce random hex (replay metadata)
 * @property {{ algorithm: string, iv: string, ciphertext: string, tag: string }} encryption AEAD output (base64)
 * @property {{ algorithm: string, mac: string }} integrity encrypt-then-MAC (base64)
 * @property {null} ratchet reserved for Layer 5 forward-secrecy metadata (always null here)
 */

/**
 * @typedef {object} SessionKeys Device-local keys from Sprint 3 (`loadSessionKeys`).
 * @property {Buffer} encryptionKey 32 bytes @property {Buffer} macKey 32 bytes
 * @property {string} keyId @property {number} generation
 */

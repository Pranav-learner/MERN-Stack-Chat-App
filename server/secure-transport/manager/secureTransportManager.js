/**
 * @module secure-transport/manager
 *
 * The **Secure Transport Manager** — the reusable facade the application uses instead
 * of encrypting directly. It owns the full flow on a DEVICE:
 *
 * ```
 * encryptAndSend:  message → loadKeys → encrypt → serialize → transport
 * receiveAndDecrypt: serialized → deserialize → validate → loadKeys → decrypt → plaintext
 * ```
 *
 * Keys are fetched via an injected `keyProvider(sessionId)` (Sprint 3
 * `SecureSessionManager.loadSessionKeys`). The manager emits events + records metrics
 * (encrypt/decrypt counts, latency, ciphertext sizes).
 *
 * @security Runs where keys live (client / reference / tests). The SERVER uses only
 * {@link SecureTransportManager#relay} — which validates + forwards ciphertext and
 * NEVER decrypts (it has no `keyProvider`). No plaintext/keys are stored or logged.
 */

import { encryptMessage } from "../encryptor/encryptor.js";
import { decryptMessage } from "../decryptor/decryptor.js";
import { serialize, deserialize } from "../serializer/serializer.js";
import { validateForRelay } from "../validators/validators.js";
import { SecureTransportEventBus, SecureTransportEventType } from "../events/events.js";
import { SessionKeyError } from "../errors.js";
import { MetricsCollector } from "../../shs/hardening/observability/metrics.js";

/** Secure-transport metric names. */
export const TransportMetric = Object.freeze({
  ENCRYPTED: "transport.messages.encrypted",
  DECRYPTED: "transport.messages.decrypted",
  ENCRYPT_MS: "transport.encrypt_ms",
  DECRYPT_MS: "transport.decrypt_ms",
  CIPHERTEXT_BYTES: "transport.ciphertext_bytes",
  RELAYED: "transport.messages.relayed",
  FAILURES: "transport.failures",
});

export class SecureTransportManager {
  /**
   * @param {object} [deps]
   * @param {(sessionId: string) => (object|Promise<object>)} [deps.keyProvider] device-local session keys (device mode)
   * @param {SecureTransportEventBus} [deps.events]
   * @param {MetricsCollector} [deps.metrics]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    this.keyProvider = deps.keyProvider ?? null;
    this.events = deps.events ?? new SecureTransportEventBus();
    this.metrics = deps.metrics ?? new MetricsCollector();
    this.clock = deps.clock ?? (() => Date.now());
  }

  // === device operations (require keyProvider) =============================

  /**
   * Encrypt an application message into a serialized {@link SecurePayload}.
   * @param {object} message @param {object} context `{ sessionId, senderDevice, receiverDevice, type? }`
   * @returns {Promise<{ payload: object, serialized: string }>}
   * @throws {SessionKeyError}
   */
  async encrypt(message, context) {
    const keys = await this._keys(context.sessionId);
    const start = this.clock();
    const payload = encryptMessage(message, keys, { ...context, clock: this.clock });
    const serialized = serialize(payload);
    this.metrics.observe(TransportMetric.ENCRYPT_MS, this.clock() - start);
    this.metrics.observe(TransportMetric.CIPHERTEXT_BYTES, Buffer.byteLength(serialized, "utf8"));
    this.metrics.increment(TransportMetric.ENCRYPTED);
    this.events.emit(SecureTransportEventType.MESSAGE_ENCRYPTED, {
      sessionId: context.sessionId,
      keyId: keys.keyId,
      messageType: payload.type,
      bytes: Buffer.byteLength(serialized, "utf8"),
    });
    return { payload, serialized };
  }

  /**
   * Decrypt a received serialized/object {@link SecurePayload} back to the message.
   * @param {string|object} serializedOrPayload @param {{ expectedReceiverDevice?: string }} [options]
   * @returns {Promise<object>} the plaintext message
   */
  async decrypt(serializedOrPayload, options = {}) {
    const payload = typeof serializedOrPayload === "string" ? deserialize(serializedOrPayload) : deserialize(serializedOrPayload);
    const keys = await this._keys(payload.sessionId);
    const start = this.clock();
    try {
      const message = decryptMessage(payload, keys, options);
      this.metrics.observe(TransportMetric.DECRYPT_MS, this.clock() - start);
      this.metrics.increment(TransportMetric.DECRYPTED);
      this.events.emit(SecureTransportEventType.MESSAGE_DECRYPTED, { sessionId: payload.sessionId, keyId: payload.keyId, messageType: payload.type });
      return message;
    } catch (error) {
      this.metrics.increment(TransportMetric.FAILURES);
      this.events.emit(SecureTransportEventType.DECRYPTION_FAILURE, { sessionId: payload.sessionId, reason: error.code });
      throw error;
    }
  }

  /**
   * Encrypt + send over a {@link Transport}.
   * @param {object} message @param {object} context @param {import("../transport/transport.js").BaseTransport} transport
   * @returns {Promise<{ payload: object, serialized: string, delivery: any }>}
   */
  async encryptAndSend(message, context, transport) {
    const { payload, serialized } = await this.encrypt(message, context);
    const delivery = await transport.send(serialized, { sessionId: context.sessionId, type: payload.type });
    this.events.emit(SecureTransportEventType.TRANSPORT_SENT, { sessionId: context.sessionId, bytes: Buffer.byteLength(serialized, "utf8") });
    return { payload, serialized, delivery };
  }

  // === relay (server; no keys, never decrypts) ============================

  /**
   * Validate + forward a ciphertext payload WITHOUT decrypting (the server relay).
   * @param {string|object} serializedOrPayload
   * @param {{ sessionId?: string, senderDevice?: string }} [expected]
   * @returns {{ payload: object, meta: object }} the validated payload + metadata (for persistence/routing)
   * @throws {MalformedPayloadError | VersionMismatchError | SessionMismatchError}
   */
  relay(serializedOrPayload, expected = {}) {
    const payload = typeof serializedOrPayload === "string" ? deserialize(serializedOrPayload) : deserialize(serializedOrPayload);
    const meta = validateForRelay(payload, expected);
    this.metrics.increment(TransportMetric.RELAYED);
    this.events.emit(SecureTransportEventType.RELAYED, { sessionId: meta.sessionId, messageType: meta.type });
    return { payload, meta };
  }

  /** Aggregate secure-transport metrics (no PII). */
  metricsSnapshot() {
    return this.metrics.snapshot();
  }

  // === internals ==========================================================

  /** @private */
  async _keys(sessionId) {
    if (!this.keyProvider) {
      throw new SessionKeyError("This manager is a relay (no keyProvider) — it cannot encrypt/decrypt");
    }
    const keys = await this.keyProvider(sessionId);
    if (!keys) throw new SessionKeyError("No session keys for this session", { details: { sessionId } });
    return keys;
  }
}

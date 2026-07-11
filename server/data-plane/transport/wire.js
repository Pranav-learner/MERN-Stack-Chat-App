/**
 * @module data-plane/transport
 *
 * **Wire envelopes + the transport contract.** Defines what crosses an Active Connection — a DATA
 * envelope (opaque ciphertext + routing metadata + sequence) or an ACK envelope — and the injected
 * transport interface the engine sends through. Keeping the transport INJECTED is what makes the
 * engine reuse any Layer-7 connection (WebRTC / QUIC / relay / TCP).
 *
 * @security A wire envelope carries CIPHERTEXT + routing metadata ONLY. The `payload` is the crypto
 * layer's opaque ciphertext; the engine never decodes it. ACKs carry ids only — never plaintext.
 *
 * ## Transport contract
 * A transport is any object with `send(envelope) -> Promise<void>` that delivers the envelope over
 * the peer's Active Connection (routing by `envelope.receiver` / `envelope.connectionId`). It throws
 * when no live connection exists (the engine then queues/retransmits). Inbound envelopes are fed to
 * the engine's `receive(envelope)`.
 */

import { WireType, AckType, MESSAGING_PROTOCOL_VERSION } from "../types/types.js";

/** Build a DATA wire envelope from a message (ciphertext only). */
export function buildDataEnvelope(message, options = {}) {
  return {
    type: WireType.DATA,
    protocol: MESSAGING_PROTOCOL_VERSION,
    messageId: message.messageId,
    conversationId: message.conversationId,
    sender: message.senderDeviceId,
    receiver: message.receiverDeviceId,
    connectionId: message.connectionId ?? null,
    seq: message.sequenceNumber,
    payload: message.encryptedPayload, // OPAQUE ciphertext
    retry: message.retryCount ?? 0,
    ts: options.ts ?? new Date().toISOString(),
  };
}

/**
 * Build an ACK wire envelope. Carries the acknowledged message id + sequence — never plaintext.
 * @param {object} params `{ messageId, conversationId, sender, receiver, seq, ackType?, connectionId? }`
 * @returns {import("../types/types.js").WireEnvelope}
 */
export function buildAckEnvelope(params) {
  return {
    type: WireType.ACK,
    protocol: MESSAGING_PROTOCOL_VERSION,
    messageId: params.messageId,
    conversationId: params.conversationId,
    sender: params.sender, // the ACK's sender = the original receiver
    receiver: params.receiver, // the ACK's receiver = the original sender
    connectionId: params.connectionId ?? null,
    ack: {
      ackType: params.ackType ?? AckType.ACK,
      messageId: params.messageId,
      seq: params.seq,
      ackId: params.ackId,
    },
    ts: params.ts ?? new Date().toISOString(),
  };
}

/** Whether an object is a well-formed wire envelope (shape check; not a content check). */
export function isWireEnvelope(envelope) {
  return !!envelope && (envelope.type === WireType.DATA || envelope.type === WireType.ACK) && typeof envelope.messageId === "string";
}

/**
 * Build an in-memory **loopback transport** that connects two engines directly (for tests + device-
 * local use). `route(receiverDeviceId) -> engine` resolves the peer engine; a sent envelope is
 * delivered to that engine's `receive()` on a microtask (async, like a real transport).
 *
 * @param {object} options
 * @param {(receiver: string) => (object|null)} options.route resolve the peer engine by receiver id
 * @param {() => boolean} [options.up] whether the link is currently up (simulate disconnects)
 * @param {(envelope: object) => void} [options.onSend] observe every send
 * @returns {{ send: (envelope: object) => Promise<void> }}
 */
export function createLoopbackTransport(options) {
  return {
    async send(envelope) {
      options.onSend?.(envelope);
      if (options.up && !options.up()) {
        const err = new Error("loopback link is down");
        err.code = "ERR_DATAPLANE_NO_CONNECTION";
        throw err;
      }
      const peer = options.route(envelope.receiver);
      if (!peer) {
        const err = new Error(`no peer engine for "${envelope.receiver}"`);
        err.code = "ERR_DATAPLANE_NO_CONNECTION";
        throw err;
      }
      // Deliver asynchronously (next microtask) so send() returns before receive() runs.
      await Promise.resolve();
      await peer.receive(envelope);
    },
  };
}

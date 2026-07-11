/**
 * @module transport-engine/transport
 *
 * **Wire envelopes + the transport contract** for large-payload transport. Defines what crosses an
 * Active Connection — a CHUNK envelope (opaque ciphertext fragment + position + checksum), a CHUNK-ACK
 * envelope (acknowledged chunk ids + advertised receiver window), and a CONTROL envelope (pause /
 * resume / cancel). The transport is INJECTED, so the engine reuses any Layer-7 connection.
 *
 * @security A chunk envelope carries CIPHERTEXT + position metadata + an integrity checksum ONLY. The
 * `data` is the crypto layer's opaque ciphertext fragment; the engine never decodes it. ACK/control
 * envelopes carry ids + counters only — never plaintext or keys.
 *
 * ## Transport contract
 * A transport is any object with `send(envelope) -> Promise<void>` that delivers the envelope over the
 * peer's Active Connection (routing by `envelope.receiver`) and throws when no live connection exists.
 * Inbound envelopes are fed to the engine's `receive(envelope)`.
 *
 * In production each CHUNK envelope can be carried as ONE Sprint-1 reliable message (filling that
 * layer's reserved `fragment` slot) so per-chunk delivery inherits ACK + retransmission + ordering for
 * free. The shapes below are deliberately compatible with a data-plane message payload.
 */

import { TransportWireType, ChunkAckKind, TransferControl, TRANSPORT_PROTOCOL_VERSION } from "../types/types.js";

/** Build a CHUNK wire envelope from a chunk record (ciphertext fragment only). */
export function buildChunkEnvelope(chunk, ctx, options = {}) {
  return {
    type: TransportWireType.CHUNK,
    protocol: TRANSPORT_PROTOCOL_VERSION,
    transferId: chunk.transferId,
    chunkId: chunk.chunkId,
    conversationId: chunk.conversationId,
    sender: ctx.sender,
    receiver: ctx.receiver,
    index: chunk.index,
    total: chunk.total,
    offset: chunk.offset,
    size: chunk.size,
    data: chunk.data, // OPAQUE ciphertext fragment (base64)
    checksum: chunk.checksum,
    priority: chunk.priority,
    retry: chunk.retryCount ?? 0,
    payloadMeta: options.payloadMeta, // sent with the first chunk so the receiver can size reassembly
    ts: options.ts ?? new Date().toISOString(),
  };
}

/** Build a CHUNK-ACK wire envelope (acknowledged ids + advertised receiver window). */
export function buildChunkAckEnvelope(params) {
  return {
    type: TransportWireType.CHUNK_ACK,
    protocol: TRANSPORT_PROTOCOL_VERSION,
    transferId: params.transferId,
    conversationId: params.conversationId,
    sender: params.sender, // the ACK's sender = the original receiver
    receiver: params.receiver, // the ACK's receiver = the original sender
    ackKind: params.ackKind ?? ChunkAckKind.ACK,
    chunkIds: params.chunkIds ?? [],
    receiverWindow: params.receiverWindow,
    ts: params.ts ?? new Date().toISOString(),
  };
}

/** Build a CONTROL wire envelope (pause / resume / cancel / complete). */
export function buildControlEnvelope(params) {
  return {
    type: TransportWireType.CONTROL,
    protocol: TRANSPORT_PROTOCOL_VERSION,
    transferId: params.transferId,
    conversationId: params.conversationId,
    sender: params.sender,
    receiver: params.receiver,
    control: params.control ?? TransferControl.PAUSE,
    ts: params.ts ?? new Date().toISOString(),
  };
}

/** Whether an object is a well-formed transport wire envelope (shape check, not content). */
export function isTransportEnvelope(envelope) {
  return !!envelope && Object.values(TransportWireType).includes(envelope.type) && typeof envelope.transferId === "string";
}

/**
 * Build an in-memory **loopback network** for tests + device-local use: `send(envelope)` enqueues,
 * and `flush()` delivers queued envelopes to the routed peer engines until quiescent (so a full
 * multi-chunk transfer — chunks + ACKs + re-pumps — runs to completion deterministically without
 * recursion). Register peers on the returned `routes` map (`receiverId -> engine`).
 *
 * @returns {{ transport: { send: (e: object) => Promise<void> }, routes: Map<string, object>, flush: (max?: number) => Promise<number>, pending: () => number, drop: (predicate: (e: object) => boolean) => void }}
 */
export function createLoopbackNetwork(options = {}) {
  const routes = new Map();
  const queue = [];
  let dropNext = options.drop ?? null; // optional predicate to drop envelopes (simulate loss)
  const onSend = options.onSend ?? null;

  const transport = {
    async send(envelope) {
      onSend?.(envelope);
      if (dropNext && dropNext(envelope)) return; // simulate loss (dropped silently)
      queue.push(envelope);
    },
  };

  async function flush(max = 1_000_000) {
    let steps = 0;
    let delivered = 0;
    while (queue.length) {
      if (++steps > max) throw new Error("loopback flush did not converge (possible send/ack loop)");
      const env = queue.shift();
      const peer = routes.get(env.receiver);
      if (peer) {
        await peer.receive(env);
        delivered++;
      }
    }
    return delivered;
  }

  return {
    transport,
    routes,
    flush,
    pending: () => queue.length,
    setDrop: (predicate) => (dropNext = predicate),
    drop: (predicate) => (dropNext = predicate),
  };
}

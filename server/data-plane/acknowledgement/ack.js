/**
 * @module data-plane/acknowledgement
 *
 * The **ACK protocol** helpers. On receiving a DATA message a receiver generates an ACK; the sender
 * matches it to a pending message and marks it delivered. Supports normal ACKs, duplicate ACKs
 * (re-ACK of an already-received message), delayed/batched ACKs, ACK validation, and — via the
 * engine's retransmission sweep — missing-ACK detection + ACK timeout/retry.
 *
 * @security An ACK carries the acknowledged `messageId` + `seq` + an `ackId` — NEVER plaintext or key
 * material. {@link validateAckBlock} rejects a malformed ACK.
 */

import crypto from "node:crypto";
import { AckType } from "../types/types.js";
import { MessageValidationError } from "../errors.js";
import { buildAckEnvelope } from "../transport/wire.js";

/** Generate a fresh ACK id. */
export function newAckId() {
  return crypto.randomUUID();
}

/**
 * Build an ACK envelope for an inbound message. `ackType` distinguishes a normal ACK from a
 * duplicate-ACK (re-ACK of an already-seen message) or a delayed ACK.
 * @param {object} inbound the DATA wire envelope being acknowledged
 * @param {{ ackType?: string, ackId?: string, ts?: string }} [options]
 * @returns {import("../types/types.js").WireEnvelope}
 */
export function buildAck(inbound, options = {}) {
  return buildAckEnvelope({
    messageId: inbound.messageId,
    conversationId: inbound.conversationId,
    sender: inbound.receiver, // ACK originates from the original receiver
    receiver: inbound.sender, // and goes back to the original sender
    connectionId: inbound.connectionId ?? null,
    seq: inbound.seq,
    ackType: options.ackType ?? AckType.ACK,
    ackId: options.ackId ?? newAckId(),
    ts: options.ts,
  });
}

/** Validate an ACK block's shape. @throws {MessageValidationError} */
export function validateAckBlock(ack) {
  if (!ack || typeof ack !== "object") throw new MessageValidationError("ACK block is not an object");
  if (typeof ack.messageId !== "string" || !ack.messageId) throw new MessageValidationError("ACK missing messageId");
  if (ack.ackType && !Object.values(AckType).includes(ack.ackType)) throw new MessageValidationError(`Unknown ACK type "${ack.ackType}"`);
  return ack;
}

/**
 * A **delayed-ACK batcher** — accumulates message ids to acknowledge and flushes them together on a
 * threshold or a timer tick, reducing ACK chatter on high-throughput conversations. Pure/in-memory;
 * the engine drives the flush.
 */
export class DelayedAckBatcher {
  /** @param {{ maxBatch?: number }} [options] */
  constructor(options = {}) {
    this.maxBatch = options.maxBatch ?? 16;
    /** @type {Map<string, object[]>} conversationId -> pending inbound envelopes */
    this._pending = new Map();
  }

  /** Queue an inbound message for a delayed ACK. @returns {boolean} whether the batch is now full */
  queue(inbound) {
    const list = this._pending.get(inbound.conversationId) ?? [];
    list.push(inbound);
    this._pending.set(inbound.conversationId, list);
    return list.length >= this.maxBatch;
  }

  /** Flush pending ACKs for a conversation (or all). @returns {object[]} the inbound envelopes to ACK */
  flush(conversationId) {
    if (conversationId) {
      const list = this._pending.get(conversationId) ?? [];
      this._pending.delete(conversationId);
      return list;
    }
    const all = [];
    for (const list of this._pending.values()) all.push(...list);
    this._pending.clear();
    return all;
  }

  /** Number of pending (un-flushed) ACKs. */
  get size() {
    let n = 0;
    for (const list of this._pending.values()) n += list.length;
    return n;
  }
}

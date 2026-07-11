/**
 * @module data-plane/api
 *
 * The **data-plane service facade** — assembles a {@link MessagingEngine} over a repository bundle +
 * an injected transport, wires the retransmission scheduler, and exposes the operations a controller
 * (or a device-local caller) needs: send, status, pending, history, diagnostics, cancel, and the
 * sweeps. Keeps the HTTP/controller layer free of engine wiring.
 *
 * @security Every method returns metadata DTOs (no plaintext). Sending accepts opaque ciphertext only.
 */

import { MessagingEngine } from "../manager/messagingEngine.js";
import { RetransmissionScheduler } from "../retransmission/retransmission.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { MessagingEventBus } from "../events/events.js";

/**
 * Build a data-plane service for a device.
 *
 * @param {object} deps
 * @param {string} deps.deviceId
 * @param {{ send: (envelope: object) => Promise<void> }} deps.transport
 * @param {object} [deps.repository] a `{ messages, inbound, ackHistory, ordering }` bundle (defaults to in-memory)
 * @param {(receiverDeviceId: string) => (object|null)} [deps.connectionResolver]
 * @param {object} [deps.retryPolicy] @param {MessagingEventBus} [deps.events]
 * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
 * @param {{ intervalMs?: number, autoStart?: boolean }} [deps.scheduler]
 * @returns {DataPlaneService}
 */
export function createDataPlaneService(deps) {
  return new DataPlaneService(deps);
}

export class DataPlaneService {
  constructor(deps) {
    if (!deps || !deps.deviceId) throw new Error("DataPlaneService requires { deviceId }");
    if (!deps.transport) throw new Error("DataPlaneService requires { transport }");
    const repository = deps.repository ?? createInMemoryMessageRepository();
    this.repository = repository;
    this.events = deps.events ?? new MessagingEventBus();
    this.engine = new MessagingEngine({
      deviceId: deps.deviceId,
      messages: repository.messages,
      inbound: repository.inbound,
      ackHistory: repository.ackHistory,
      ordering: repository.ordering,
      transport: deps.transport,
      connectionResolver: deps.connectionResolver,
      retryPolicy: deps.retryPolicy,
      events: this.events,
      clock: deps.clock,
      idGenerator: deps.idGenerator,
    });
    this.scheduler = new RetransmissionScheduler({
      engine: this.engine,
      intervalMs: deps.scheduler?.intervalMs,
    });
    if (deps.scheduler?.autoStart) this.scheduler.start();
  }

  get deviceId() {
    return this.engine.deviceId;
  }

  /** Send an encrypted message. @returns {Promise<{ message: object }>} */
  send(request) {
    return this.engine.send(request);
  }

  /** Feed an inbound wire envelope (DATA or ACK) from the transport into the engine. */
  receive(envelope) {
    return this.engine.receive(envelope);
  }

  /** Register the application ciphertext-delivery handler. @returns {() => void} */
  onMessage(handler) {
    return this.engine.onMessage(handler);
  }

  /** Subscribe to data-plane events. @returns {() => void} */
  onEvent(type, handler) {
    return this.engine.onEvent(type, handler);
  }

  /** A message's delivery status. */
  getStatus(messageId) {
    return this.engine.getStatus(messageId);
  }

  /** A message's public DTO. */
  getMessage(messageId, options) {
    return this.engine.getMessage(messageId, options);
  }

  /** Pending (in-flight) messages. */
  getPending(connectionId) {
    return this.engine.getPending(connectionId);
  }

  /** Delivery history for a conversation. */
  getHistory(conversationId, options) {
    return this.engine.getHistory(conversationId, options);
  }

  /** Diagnostics for a conversation. */
  getDiagnostics(conversationId, options) {
    return this.engine.getDiagnostics(conversationId, options);
  }

  /** Cancel an active outbound message. */
  cancel(messageId, options) {
    return this.engine.cancel(messageId, options);
  }

  /** Flush pending messages over a (re)connected link. */
  flushPending(connectionId) {
    return this.engine.flushPending(connectionId);
  }

  /** Run one retransmission sweep. */
  sweepRetries(now) {
    return this.engine.sweepRetries(now);
  }

  /** Run one expiry sweep. */
  sweepExpired(now) {
    return this.engine.sweepExpired(now);
  }

  /** Start the background retransmission scheduler. */
  start() {
    this.scheduler.start();
  }

  /** Stop the background retransmission scheduler. */
  stop() {
    this.scheduler.stop();
  }
}

/**
 * @module secure-transport/transport
 *
 * The **transport abstraction**. The Secure Transport Layer is transport-independent:
 * it produces/consumes serialized {@link SecurePayload}s and hands them to a
 * `Transport` implementation that knows how to move bytes. REST, WebSocket, WebRTC,
 * QUIC, and TURN-relay transports all implement the SAME interface, so none of the
 * crypto/serialization changes when the transport does.
 *
 * @security A transport moves ciphertext only. It never sees keys or plaintext.
 */

import { TransportError } from "../errors.js";

/**
 * @interface Transport
 * @property {(serialized: string, meta: object) => Promise<any>} send deliver a serialized payload
 * @property {(handler: (serialized: string, meta: object) => void) => (() => void)} [subscribe] receive payloads
 * @property {string} name
 */

/**
 * A base transport that adapts a `send` (and optional `subscribe`) function to the
 * {@link Transport} interface with error wrapping.
 */
export class BaseTransport {
  /** @param {{ name?: string, send: Function, subscribe?: Function }} impl */
  constructor(impl) {
    if (!impl || typeof impl.send !== "function") throw new Error("A transport requires a send(serialized, meta) function");
    this.name = impl.name ?? "custom";
    this._send = impl.send;
    this._subscribe = impl.subscribe ?? null;
  }

  /** Deliver a serialized secure payload. @throws {TransportError} */
  async send(serialized, meta = {}) {
    try {
      return await this._send(serialized, meta);
    } catch (error) {
      throw new TransportError(`Transport "${this.name}" send failed`, { cause: error });
    }
  }

  /** Subscribe to inbound payloads (if the transport supports push). */
  subscribe(handler) {
    if (!this._subscribe) throw new TransportError(`Transport "${this.name}" does not support subscribe`);
    return this._subscribe(handler);
  }
}

/**
 * An in-memory loopback transport for tests + as the reference. `send` enqueues; a
 * subscriber receives. Models a relay without a network.
 */
export class InMemoryTransport extends BaseTransport {
  constructor() {
    const handlers = new Set();
    super({
      name: "in-memory",
      send: async (serialized, meta) => {
        for (const h of handlers) h(serialized, meta);
        return { delivered: handlers.size };
      },
      subscribe: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    });
  }
}

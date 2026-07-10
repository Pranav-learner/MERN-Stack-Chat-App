/**
 * @module secure-transport/adapters
 *
 * Concrete {@link Transport} adapters. Each moves a serialized {@link SecurePayload}
 * over a specific channel — REST or WebSocket today; WebRTC / QUIC / TURN reuse the
 * SAME interface later. They carry ciphertext only; none touch keys or plaintext.
 */

import { BaseTransport } from "../transport/transport.js";

/**
 * A REST transport: `send` posts a serialized payload via an injected HTTP function.
 * @param {{ post: (serialized: string, meta: object) => Promise<any> }} deps
 * @returns {BaseTransport}
 */
export function createRestTransport(deps) {
  if (!deps || typeof deps.post !== "function") throw new Error("createRestTransport requires a post(serialized, meta) function");
  return new BaseTransport({ name: "rest", send: (serialized, meta) => deps.post(serialized, meta) });
}

/**
 * A WebSocket transport: `send` emits a serialized payload; `subscribe` receives them.
 * @param {{ emit: (serialized: string, meta: object) => any, on?: (handler: Function) => (() => void) }} deps
 * @returns {BaseTransport}
 */
export function createSocketTransport(deps) {
  if (!deps || typeof deps.emit !== "function") throw new Error("createSocketTransport requires an emit(serialized, meta) function");
  return new BaseTransport({
    name: "websocket",
    send: (serialized, meta) => deps.emit(serialized, meta),
    subscribe: deps.on,
  });
}

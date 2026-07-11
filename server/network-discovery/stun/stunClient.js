/**
 * @module network-discovery/stun/stunClient
 *
 * A **modular STUN client**. It builds a Binding Request via the {@link module:network-discovery/stun/stunMessage
 * codec}, sends it through an INJECTED transport (real UDP in Node, a mock in tests), and decodes the
 * server-reflexive address — with per-server timeout, retries, fallback across a server list, and
 * latency measurement. It performs NO connectivity checks and opens NO peer socket; it only asks a
 * STUN server "what public address do you see?".
 *
 * @security The client handles addressing metadata only. It validates the response's transaction id
 * matches the request (anti-spoof) before trusting the mapped address.
 *
 * @example
 * ```js
 * const stun = new StunClient({ transport, servers: DEFAULT_STUN_SERVERS });
 * const r = await stun.resolve();          // { server, reflexive: { ip, port }, latencyMs }
 * const all = await stun.resolveAll();     // one result per server (for NAT symmetric detection)
 * ```
 */

import {
  DEFAULT_STUN_SERVERS,
  DEFAULT_STUN_TIMEOUT_MS,
  DEFAULT_STUN_RETRIES,
  DiscoveryFailureReason,
} from "../types/types.js";
import { buildBindingRequest, parseStunMessage } from "./stunMessage.js";
import { StunError } from "../errors.js";

export class StunClient {
  /**
   * @param {object} deps
   * @param {{ query: (message: Buffer, server: object, options: object) => Promise<Buffer> }} deps.transport
   * @param {Array<{host:string,port:number}>} [deps.servers]
   * @param {number} [deps.timeoutMs] @param {number} [deps.retries]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    if (!deps.transport || typeof deps.transport.query !== "function") {
      throw new Error("StunClient requires a transport with query(message, server, options)");
    }
    this.transport = deps.transport;
    this.servers = deps.servers ?? DEFAULT_STUN_SERVERS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_STUN_TIMEOUT_MS;
    this.retries = deps.retries ?? DEFAULT_STUN_RETRIES;
    this.clock = deps.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  /**
   * Resolve the public address against a single server, retrying + falling back down the server list.
   * @param {{ servers?: Array<object>, timeoutMs?: number, retries?: number }} [options]
   * @returns {Promise<{ server: object, reflexive: { ip: string, port: number, family: string }, latencyMs: number, attempts: number }>}
   * @throws {StunError} when every server/attempt fails.
   */
  async resolve(options = {}) {
    const servers = options.servers ?? this.servers;
    if (!servers || servers.length === 0) throw new StunError("No STUN servers configured", { reason: DiscoveryFailureReason.STUN_UNREACHABLE });
    let lastError;
    for (const server of servers) {
      try {
        return await this._queryServer(server, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new StunError("STUN resolution failed", { reason: DiscoveryFailureReason.STUN_TIMEOUT });
  }

  /**
   * Resolve against EVERY server (used by NAT detection to spot a symmetric mapping). Never throws —
   * returns one entry per server, marking failures.
   * @param {{ servers?: Array<object>, timeoutMs?: number, retries?: number }} [options]
   * @returns {Promise<Array<{ server: object, ok: boolean, reflexive?: object, latencyMs?: number, error?: string }>>}
   */
  async resolveAll(options = {}) {
    const servers = options.servers ?? this.servers;
    return Promise.all(
      servers.map(async (server) => {
        try {
          const r = await this._queryServer(server, options);
          return { server, ok: true, reflexive: r.reflexive, latencyMs: r.latencyMs, attempts: r.attempts };
        } catch (error) {
          return { server, ok: false, error: error?.reason ?? error?.message ?? "stun-failed" };
        }
      }),
    );
  }

  /** @private Query one server with retries + a timeout, measuring latency. */
  async _queryServer(server, options) {
    const retries = options.retries ?? this.retries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let lastError;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const { message, transactionId } = buildBindingRequest();
      const start = this.clock();
      try {
        const response = await this.transport.query(message, server, { timeoutMs });
        const latencyMs = Math.max(0, this.clock() - start);
        const parsed = parseStunMessage(response);
        if (!transactionId.equals(parsed.transactionId)) throw new StunError("STUN transaction id mismatch", { reason: DiscoveryFailureReason.STUN_UNREACHABLE });
        if (!parsed.isSuccess || !parsed.mappedAddress) throw new StunError("STUN response had no mapped address", { reason: DiscoveryFailureReason.STUN_UNREACHABLE });
        return { server, reflexive: parsed.mappedAddress, latencyMs: Number(latencyMs.toFixed(2)), attempts: attempt };
      } catch (error) {
        lastError = error instanceof StunError ? error : new StunError(error?.message ?? "STUN query failed", { reason: DiscoveryFailureReason.STUN_TIMEOUT, cause: error });
      }
    }
    throw lastError;
  }
}

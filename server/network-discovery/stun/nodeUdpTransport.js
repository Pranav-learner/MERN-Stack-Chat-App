/**
 * @module network-discovery/stun/nodeUdpTransport
 *
 * A **Node UDP transport** for the {@link module:network-discovery/stun/stunClient StunClient} — the
 * production wiring that actually sends a STUN Binding Request to a STUN server over UDP and returns
 * the response bytes. It binds an ephemeral UDP socket per query, sends, awaits one datagram with a
 * timeout, and closes.
 *
 * @important This opens a UDP socket ONLY to talk to a STUN server (the discovery mechanism) — it is
 * NOT a peer connection or a relay. No ICE checks, no candidate pairs, no TURN.
 *
 * @security The socket is bound to an ephemeral local port, used for one query, and closed. No key
 * material is involved.
 *
 * @example
 * ```js
 * import { StunClient } from "./stunClient.js";
 * import { createNodeUdpStunTransport } from "./nodeUdpTransport.js";
 * const stun = new StunClient({ transport: createNodeUdpStunTransport() });
 * ```
 */

import dgram from "node:dgram";

/**
 * Build a UDP STUN transport.
 * @param {{ family?: "udp4"|"udp6" }} [options]
 * @returns {{ query: (message: Buffer, server: {host:string,port:number}, options: {timeoutMs?:number}) => Promise<Buffer> }}
 */
export function createNodeUdpStunTransport(options = {}) {
  const family = options.family ?? "udp4";
  return {
    /** Send one STUN message + resolve with the first response datagram (or reject on timeout). */
    query(message, server, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 500;
      return new Promise((resolve, reject) => {
        const socket = dgram.createSocket(family);
        let settled = false;
        const done = (err, data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch {
            /* already closed */
          }
          if (err) reject(err);
          else resolve(data);
        };
        const timer = setTimeout(() => done(new Error("STUN UDP timeout")), timeoutMs);
        socket.once("message", (data) => done(null, data));
        socket.once("error", (err) => done(err));
        try {
          socket.send(message, server.port, server.host, (err) => {
            if (err) done(err);
          });
        } catch (err) {
          done(err);
        }
      });
    },
  };
}

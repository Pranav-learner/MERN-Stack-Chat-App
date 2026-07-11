/**
 * @module network-discovery/candidates
 *
 * **Candidate gathering** — turns host interfaces + STUN results into ICE-style
 * {@link ConnectionCandidate}s (RFC 8445 shape): host candidates (local addresses), server-reflexive
 * candidates (the public address STUN observed), and inert relay PLACEHOLDERS (TURN is a future
 * sprint). Each candidate gets an RFC 8445 priority + foundation + an SDP `a=candidate:` line, ready
 * for ICE.
 *
 * @important This module GATHERS candidates only. It performs NO connectivity checks, NO candidate-
 * pair selection, and opens NO socket. Ports come from device-reported/socket-bound data supplied by
 * the caller — this sprint never binds a peer socket.
 *
 * @security A candidate is PUBLIC addressing metadata — ip/port/type/priority. No key material.
 */

import crypto from "node:crypto";
import {
  CandidateType,
  TYPE_PREFERENCE,
  TransportProtocol,
  AddressFamily,
  DEFAULT_COMPONENT_ID,
  DEFAULT_CANDIDATE_TTL_MS,
} from "../types/types.js";
import { isPrivateIPv4, isLinkLocalIPv6 } from "../interfaces/interfaces.js";

/**
 * RFC 8445 §5.1.2.1 candidate priority:
 * `priority = 2^24 * typePreference + 2^8 * localPreference + (256 - componentId)`.
 * @param {string} type @param {number} localPref 0..65535 @param {number} [component]
 * @returns {number}
 */
export function computePriority(type, localPref, component = DEFAULT_COMPONENT_ID) {
  const typePref = TYPE_PREFERENCE[type] ?? 0;
  const lp = Math.max(0, Math.min(65535, localPref));
  return 2 ** 24 * typePref + 2 ** 8 * lp + (256 - component);
}

/**
 * RFC 8445 §5.1.1.3 foundation: candidates share a foundation when they have the same type, base IP,
 * protocol, and (for reflexive/relay) STUN/TURN server. Deterministic short hash.
 * @param {{ type: string, baseIp: string, protocol: string, serverKey?: string }} params
 * @returns {string}
 */
export function computeFoundation(params) {
  const key = `${params.type}|${params.baseIp}|${params.protocol}|${params.serverKey ?? ""}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** A local preference derived from family + interface index (IPv4 slightly preferred; earlier = higher). */
function localPreferenceFor(family, index) {
  const base = family === AddressFamily.IPV6 ? 60000 : 65535;
  return Math.max(0, base - index * 10);
}

/** Build the SDP `a=candidate:` line for a candidate. */
export function candidateToSdp(c) {
  let line = `candidate:${c.foundation} ${c.component} ${c.transport.toUpperCase()} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
  if (c.relatedAddress && c.relatedPort != null) line += ` raddr ${c.relatedAddress} rport ${c.relatedPort}`;
  return line;
}

/** Finalize a candidate object (id, foundation, priority, sdp, timestamps). */
function finalizeCandidate(base, options) {
  const clock = options.clock ?? (() => Date.now());
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const ttlMs = options.ttlMs ?? DEFAULT_CANDIDATE_TTL_MS;
  const foundation = computeFoundation({ type: base.type, baseIp: base.relatedAddress ?? base.ip, protocol: base.transport, serverKey: base.serverKey });
  const priority = computePriority(base.type, base.localPref ?? 65535, base.component);
  const c = {
    candidateId: idGenerator(),
    foundation,
    component: base.component ?? DEFAULT_COMPONENT_ID,
    transport: base.transport ?? TransportProtocol.UDP,
    priority,
    type: base.type,
    ip: base.ip,
    port: base.port,
    family: base.family,
    relatedAddress: base.relatedAddress ?? null,
    relatedPort: base.relatedPort ?? null,
    metadata: base.metadata ?? {},
    gatheredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
  c.sdp = candidateToSdp(c);
  return c;
}

/**
 * Build a HOST candidate from a local interface address.
 * @param {{ ip: string, port: number, family?: string, protocol?: string, component?: number, localPref?: number, ttlMs?: number, metadata?: object, clock?: Function, idGenerator?: Function }} params
 * @returns {import("../types/types.js").ConnectionCandidate}
 */
export function createHostCandidate(params) {
  return finalizeCandidate(
    {
      type: CandidateType.HOST,
      ip: params.ip,
      port: params.port ?? 0,
      family: params.family ?? AddressFamily.IPV4,
      transport: params.protocol ?? TransportProtocol.UDP,
      component: params.component,
      localPref: params.localPref ?? 65535,
      metadata: params.metadata,
    },
    params,
  );
}

/**
 * Build a SERVER-REFLEXIVE (srflx) candidate from a STUN result. Its `relatedAddress` is the base
 * (host) address it maps from.
 * @param {{ ip: string, port: number, base: {ip:string,port:number}, server?: object, family?: string, protocol?: string, component?: number, localPref?: number, ttlMs?: number, metadata?: object, clock?: Function, idGenerator?: Function }} params
 * @returns {import("../types/types.js").ConnectionCandidate}
 */
export function createServerReflexiveCandidate(params) {
  return finalizeCandidate(
    {
      type: CandidateType.SERVER_REFLEXIVE,
      ip: params.ip,
      port: params.port ?? 0,
      family: params.family ?? AddressFamily.IPV4,
      transport: params.protocol ?? TransportProtocol.UDP,
      component: params.component,
      localPref: params.localPref ?? 65534,
      relatedAddress: params.base?.ip ?? null,
      relatedPort: params.base?.port ?? null,
      serverKey: params.server ? `${params.server.host}:${params.server.port}` : "",
      metadata: { ...(params.metadata ?? {}), stunServer: params.server ? `${params.server.host}:${params.server.port}` : undefined },
    },
    params,
  );
}

/**
 * A RELAY candidate PLACEHOLDER. TURN allocation is a future sprint — this reserves the slot so
 * consumers can see relay is planned but not yet available. Inert (no reachable address).
 * @returns {object}
 */
export function createRelayPlaceholder() {
  return {
    type: CandidateType.RELAY,
    reserved: true,
    enabled: false,
    ip: null,
    port: null,
    metadata: { note: "TURN relay candidates are gathered in a future sprint" },
  };
}

/**
 * Gather candidates from interfaces + STUN results.
 *
 * @param {object} params
 * @param {import("../types/types.js").NetworkInterfaceDescriptor[]} params.interfaces (may carry a `port`)
 * @param {Array<{ server?: object, ok?: boolean, reflexive?: {ip:string,port:number}, base?: {ip:string,port:number} }>} [params.stunResults]
 * @param {string} [params.protocol] @param {number} [params.component] @param {number} [params.ttlMs]
 * @param {boolean} [params.includeRelayPlaceholder]
 * @param {Function} [params.clock] @param {Function} [params.idGenerator]
 * @returns {{ candidates: object[], host: object[], srflx: object[], relayPlaceholder: object|null }}
 */
export function gatherCandidates(params) {
  const opts = { clock: params.clock, idGenerator: params.idGenerator, ttlMs: params.ttlMs };
  const protocol = params.protocol ?? TransportProtocol.UDP;
  const component = params.component ?? DEFAULT_COMPONENT_ID;

  const host = (params.interfaces ?? []).map((iface, index) =>
    createHostCandidate({
      ip: iface.address,
      port: iface.port ?? params.basePort ?? 0,
      family: iface.family,
      protocol,
      component,
      localPref: localPreferenceFor(iface.family, index),
      metadata: { interface: iface.name },
      ...opts,
    }),
  );

  const srflx = (params.stunResults ?? [])
    .filter((r) => (r.ok ?? true) && r.reflexive)
    .map((r, index) =>
      createServerReflexiveCandidate({
        ip: r.reflexive.ip,
        port: r.reflexive.port,
        family: r.reflexive.family,
        base: r.base ?? (host[0] ? { ip: host[0].ip, port: host[0].port } : undefined),
        server: r.server,
        protocol,
        component,
        localPref: 65534 - index * 10,
        ...opts,
      }),
    );

  const deduped = dedupeCandidates([...host, ...srflx]);
  return {
    candidates: deduped,
    host,
    srflx,
    relayPlaceholder: params.includeRelayPlaceholder ? createRelayPlaceholder() : null,
  };
}

/** De-duplicate candidates by (type, ip, port, transport) — same transport address is one candidate. */
export function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates ?? []) {
    const key = `${c.type}|${c.ip}|${c.port}|${c.transport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Whether a candidate has passed its expiration instant. */
export function isCandidateExpired(candidate, now = Date.now()) {
  if (!candidate?.expiresAt) return false;
  return new Date(candidate.expiresAt).getTime() <= now;
}

/**
 * Normalize a device-reported raw candidate (e.g. gathered by WebRTC in the browser) into the
 * canonical shape (recomputing priority/foundation/sdp). Used by the "reported" API path.
 * @param {object} raw @param {{ clock?: Function, idGenerator?: Function, ttlMs?: number }} [options]
 * @returns {object}
 */
export function normalizeCandidate(raw, options = {}) {
  const type = raw.type ?? CandidateType.HOST;
  const family = raw.family ?? (isPrivateIPv4(raw.ip) || /\d+\.\d+\.\d+\.\d+/.test(String(raw.ip)) ? AddressFamily.IPV4 : AddressFamily.IPV6);
  return finalizeCandidate(
    {
      type,
      ip: raw.ip,
      port: raw.port ?? 0,
      family,
      transport: raw.transport ?? raw.protocol ?? TransportProtocol.UDP,
      component: raw.component,
      localPref: raw.localPref ?? (type === CandidateType.HOST ? 65535 : 65534),
      relatedAddress: raw.relatedAddress ?? raw.raddr ?? null,
      relatedPort: raw.relatedPort ?? raw.rport ?? null,
      serverKey: raw.serverKey ?? (raw.metadata?.stunServer ?? ""),
      metadata: { ...(raw.metadata ?? {}), linkLocal: isLinkLocalIPv6(raw.ip) || undefined },
    },
    options,
  );
}

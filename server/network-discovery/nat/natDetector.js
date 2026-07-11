/**
 * @module network-discovery/nat
 *
 * **NAT detection + classification.** Given the device's host addresses and the results of STUN
 * queries against one or more servers, classify the NAT the device sits behind and produce
 * reachability + diagnostics metadata. This informs candidate priorities + tells a FUTURE ICE sprint
 * how hard traversal will be.
 *
 * @important This sprint classifies from OBSERVED mapping behaviour only — it does NOT perform ICE
 * connectivity checks or the full RFC 3489 behaviour tests (filtering behaviour needs a second
 * server + a change-request, which is a future diagnostic). Cone subtypes (full/restricted/port-
 * restricted) are therefore reported as `cone`; symmetric is detected when the public mapping
 * differs across servers.
 *
 * @security NAT metadata is PUBLIC addressing info — types, ports, booleans. No key material.
 */

import { NatType, DiscoveryFailureReason } from "../types/types.js";

/**
 * Classify NAT from host addresses + STUN results.
 *
 * @param {object} params
 * @param {string[]} params.hostAddresses the device's local (private) addresses
 * @param {Array<{ server: object, ok: boolean, reflexive?: {ip:string,port:number}, latencyMs?: number, error?: string }>} params.stunResults
 * @returns {{ natType: string, symmetric: boolean, publicAddress: string|null, portMapping: object, reachability: object, diagnostics: object }}
 */
export function classifyNat(params) {
  const hostAddresses = params.hostAddresses ?? [];
  const stunResults = params.stunResults ?? [];
  const successes = stunResults.filter((r) => r.ok && r.reflexive);

  // No STUN response at all → UDP is likely blocked (or servers unreachable).
  if (stunResults.length > 0 && successes.length === 0) {
    return {
      natType: NatType.BLOCKED,
      symmetric: false,
      publicAddress: null,
      portMapping: { consistent: false, mappedPorts: [] },
      reachability: { stunReachable: false, publicReflexive: false },
      diagnostics: { reason: DiscoveryFailureReason.STUN_UNREACHABLE, servers: stunResults.length, successes: 0 },
    };
  }

  // Not enough data (no STUN attempted).
  if (successes.length === 0) {
    return {
      natType: NatType.UNKNOWN,
      symmetric: false,
      publicAddress: null,
      portMapping: { consistent: false, mappedPorts: [] },
      reachability: { stunReachable: false, publicReflexive: false },
      diagnostics: { reason: "no-stun-data" },
    };
  }

  const publicIps = new Set(successes.map((r) => r.reflexive.ip));
  const publicPorts = successes.map((r) => r.reflexive.port);
  const uniquePorts = new Set(publicPorts);
  const publicAddress = successes[0].reflexive.ip;

  // The public reflexive address equals a local host address → the device is not behind a NAT.
  const noNat = hostAddresses.includes(publicAddress);

  // Symmetric NAT: the public mapping (ip or port) differs across servers.
  const symmetric = publicIps.size > 1 || uniquePorts.size > 1;

  let natType;
  if (noNat) natType = NatType.NO_NAT;
  else if (symmetric) natType = NatType.SYMMETRIC;
  else natType = NatType.CONE; // consistent mapping — cone (subtype requires future filtering tests)

  return {
    natType,
    symmetric,
    publicAddress,
    portMapping: {
      consistent: uniquePorts.size <= 1 && publicIps.size <= 1,
      mappedPorts: [...uniquePorts],
      // Whether the NAT preserved the source port (endpoint-independent hint) — unknowable without
      // the source port, so recorded as a placeholder for future diagnostics.
      preservesPort: null,
    },
    reachability: {
      stunReachable: true,
      publicReflexive: true,
      // FUTURE (Sprint 2 · ICE): whether inbound connectivity actually works. Placeholder.
      inboundReachable: null,
      hairpinning: null,
    },
    diagnostics: {
      serversQueried: stunResults.length,
      serversResponded: successes.length,
      distinctPublicIps: publicIps.size,
      distinctPublicPorts: uniquePorts.size,
      avgLatencyMs: avg(successes.map((r) => r.latencyMs ?? 0)),
    },
  };
}

function avg(nums) {
  if (!nums.length) return 0;
  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
}

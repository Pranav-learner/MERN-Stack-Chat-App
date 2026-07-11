/**
 * STUN codec + client, interfaces, candidate generation, and NAT detection tests
 * (Layer 7, Sprint 1). Mostly pure + DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeClock, mockStunTransport, latencyClock } from "./helpers.js";
import {
  buildBindingRequest,
  parseStunMessage,
  encodeBindingResponse,
  StunMessageType,
  MAGIC_COOKIE,
} from "../stun/stunMessage.js";
import { StunClient } from "../stun/stunClient.js";
import {
  normalizeInterfaces,
  usableInterfaces,
  isPrivateIPv4,
  isLoopback,
  isLinkLocalIPv6,
  createStaticInterfaceProvider,
} from "../interfaces/interfaces.js";
import {
  gatherCandidates,
  computePriority,
  computeFoundation,
  createHostCandidate,
  createServerReflexiveCandidate,
  createRelayPlaceholder,
  normalizeCandidate,
  candidateToSdp,
  dedupeCandidates,
} from "../candidates/candidate.js";
import { classifyNat } from "../nat/natDetector.js";
import { CandidateType, TYPE_PREFERENCE, NatType } from "../types/types.js";
import { StunProtocolError, StunError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("STUN message codec (RFC 5389)", () => {
  it("builds a binding request with the magic cookie + 12-byte txid", () => {
    const { message, transactionId } = buildBindingRequest();
    assert.equal(message.length, 20);
    assert.equal(message.readUInt16BE(0), StunMessageType.BINDING_REQUEST);
    assert.equal(message.readUInt32BE(4), MAGIC_COOKIE);
    assert.equal(transactionId.length, 12);
  });

  it("round-trips XOR-MAPPED-ADDRESS for IPv4", () => {
    const { transactionId } = buildBindingRequest();
    const resp = encodeBindingResponse(transactionId, { ip: "203.0.113.45", port: 54321 });
    const parsed = parseStunMessage(resp);
    assert.equal(parsed.isSuccess, true);
    assert.equal(parsed.mappedAddress.ip, "203.0.113.45");
    assert.equal(parsed.mappedAddress.port, 54321);
    assert.ok(transactionId.equals(parsed.transactionId));
  });

  it("round-trips XOR-MAPPED-ADDRESS for IPv6", () => {
    const { transactionId } = buildBindingRequest();
    const resp = encodeBindingResponse(transactionId, { ip: "2001:db8::1", port: 9000, family: "IPv6" });
    const parsed = parseStunMessage(resp);
    assert.equal(parsed.mappedAddress.ip, "2001:db8::1");
    assert.equal(parsed.mappedAddress.port, 9000);
  });

  it("rejects a short message + a bad magic cookie", () => {
    assert.throws(() => parseStunMessage(Buffer.alloc(10)), StunProtocolError);
    const bad = Buffer.alloc(20);
    bad.writeUInt16BE(StunMessageType.BINDING_SUCCESS, 0);
    bad.writeUInt32BE(0xdeadbeef, 4);
    assert.throws(() => parseStunMessage(bad), StunProtocolError);
  });

  it("rejects an invalid IPv4 in encode", () => {
    const { transactionId } = buildBindingRequest();
    assert.throws(() => encodeBindingResponse(transactionId, { ip: "999.1.1.1", port: 1 }), StunProtocolError);
  });
});

// ---------------------------------------------------------------------------
describe("STUN client", () => {
  it("resolves the reflexive address + measures latency", async () => {
    const client = new StunClient({ transport: mockStunTransport(() => ({ ip: "198.51.100.7", port: 3478 })), servers: [{ host: "a", port: 1 }], clock: latencyClock(5) });
    const r = await client.resolve();
    assert.equal(r.reflexive.ip, "198.51.100.7");
    assert.equal(r.reflexive.port, 3478);
    assert.ok(r.latencyMs > 0);
  });

  it("falls back to the next server when the first fails", async () => {
    const client = new StunClient({ transport: mockStunTransport((server) => (server.host === "a" ? null : { ip: "198.51.100.9", port: 3478 })), servers: [{ host: "a", port: 1 }, { host: "b", port: 2 }], retries: 0, clock: latencyClock() });
    const r = await client.resolve();
    assert.equal(r.server.host, "b");
  });

  it("throws StunError when every server fails", async () => {
    const client = new StunClient({ transport: mockStunTransport(() => null), servers: [{ host: "a", port: 1 }], retries: 1, clock: latencyClock() });
    await assert.rejects(() => client.resolve(), StunError);
  });

  it("resolveAll returns one entry per server (successes + failures)", async () => {
    const client = new StunClient({ transport: mockStunTransport((s) => (s.host === "a" ? { ip: "1.2.3.4", port: 1 } : null)), servers: [{ host: "a", port: 1 }, { host: "b", port: 2 }], retries: 0, clock: latencyClock() });
    const all = await client.resolveAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].ok, true);
    assert.equal(all[1].ok, false);
  });

  it("rejects a spoofed response with a mismatched transaction id", async () => {
    // Transport ignores the request txid and uses a random one → mismatch.
    const transport = { async query() { const wrong = Buffer.alloc(12, 9); return encodeBindingResponse(wrong, { ip: "1.1.1.1", port: 1 }); } };
    const client = new StunClient({ transport, servers: [{ host: "a", port: 1 }], retries: 0, clock: latencyClock() });
    await assert.rejects(() => client.resolve(), StunError);
  });
});

// ---------------------------------------------------------------------------
describe("interfaces", () => {
  it("normalizes node-shaped + array interfaces, dedupes, flags internal/link-local", () => {
    const norm = normalizeInterfaces({
      eth0: [{ family: "IPv4", address: "192.168.0.5", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    });
    assert.equal(norm.length, 3);
    assert.ok(norm.find((i) => i.address === "127.0.0.1").internal);
    assert.ok(norm.find((i) => i.address === "fe80::1").linkLocal);
    assert.deepEqual(usableInterfaces(norm).map((i) => i.address), ["192.168.0.5"]); // internal + link-local excluded
  });

  it("address classification helpers", () => {
    assert.ok(isPrivateIPv4("10.1.2.3") && isPrivateIPv4("192.168.1.1") && isPrivateIPv4("172.16.0.1"));
    assert.ok(!isPrivateIPv4("8.8.8.8"));
    assert.ok(isLoopback("127.0.0.1") && isLoopback("::1"));
    assert.ok(isLinkLocalIPv6("fe80::abcd"));
  });

  it("static provider preserves a supplied bound port", async () => {
    const provider = createStaticInterfaceProvider({ wlo1: [{ family: "IPv4", address: "10.0.0.9", internal: false, port: 55000 }] });
    const [iface] = await provider.list();
    assert.equal(iface.port, 55000);
  });
});

// ---------------------------------------------------------------------------
describe("candidate generation (RFC 8445)", () => {
  it("computes priority with the RFC formula (host > srflx)", () => {
    const host = computePriority(CandidateType.HOST, 65535, 1);
    const srflx = computePriority(CandidateType.SERVER_REFLEXIVE, 65535, 1);
    assert.equal(host, 2 ** 24 * TYPE_PREFERENCE.host + 2 ** 8 * 65535 + 255);
    assert.ok(host > srflx);
  });

  it("foundation is stable for the same (type, base, protocol, server)", () => {
    const a = computeFoundation({ type: "host", baseIp: "10.0.0.1", protocol: "udp" });
    const b = computeFoundation({ type: "host", baseIp: "10.0.0.1", protocol: "udp" });
    const c = computeFoundation({ type: "host", baseIp: "10.0.0.2", protocol: "udp" });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("builds host + srflx candidates with SDP lines + related address", () => {
    const clock = makeClock();
    const host = createHostCandidate({ ip: "192.168.1.5", port: 50000, clock });
    assert.equal(host.type, "host");
    assert.ok(host.sdp.startsWith("candidate:"));
    assert.ok(host.sdp.includes("typ host"));

    const srflx = createServerReflexiveCandidate({ ip: "203.0.113.1", port: 40000, base: { ip: "192.168.1.5", port: 50000 }, server: { host: "s", port: 3478 }, clock });
    assert.equal(srflx.relatedAddress, "192.168.1.5");
    assert.ok(srflx.sdp.includes("raddr 192.168.1.5 rport 50000"));
  });

  it("gatherCandidates produces host + srflx, dedupes, relay placeholder is inert", () => {
    const clock = makeClock();
    const { candidates, host, srflx, relayPlaceholder } = gatherCandidates({
      interfaces: [{ name: "eth0", family: "IPv4", address: "192.168.1.5", port: 50000 }],
      stunResults: [{ ok: true, server: { host: "s", port: 3478 }, reflexive: { ip: "203.0.113.1", port: 40000 }, base: { ip: "192.168.1.5", port: 50000 } }],
      includeRelayPlaceholder: true,
      clock,
    });
    assert.equal(host.length, 1);
    assert.equal(srflx.length, 1);
    assert.equal(candidates.length, 2);
    assert.equal(relayPlaceholder.reserved, true);
    assert.equal(relayPlaceholder.enabled, false);
  });

  it("dedupeCandidates removes identical transport addresses", () => {
    const clock = makeClock();
    const a = createHostCandidate({ ip: "1.1.1.1", port: 5, clock });
    const b = createHostCandidate({ ip: "1.1.1.1", port: 5, clock });
    assert.equal(dedupeCandidates([a, b]).length, 1);
  });

  it("normalizeCandidate recomputes priority/foundation/sdp from raw (browser-reported)", () => {
    const c = normalizeCandidate({ type: "srflx", ip: "198.51.100.1", port: 33000, raddr: "10.0.0.5", rport: 55000 }, { clock: makeClock() });
    assert.ok(c.priority > 0);
    assert.equal(c.relatedAddress, "10.0.0.5");
    assert.ok(c.foundation.length === 8);
    assert.equal(candidateToSdp(c), c.sdp);
  });

  it("relay placeholder builder is inert (TURN is future)", () => {
    const relay = createRelayPlaceholder();
    assert.equal(relay.type, "relay");
    assert.equal(relay.ip, null);
    assert.equal(relay.reserved, true);
  });
});

// ---------------------------------------------------------------------------
describe("NAT detection", () => {
  it("NO_NAT when the public address equals a local host address", () => {
    const nat = classifyNat({ hostAddresses: ["203.0.113.9"], stunResults: [{ ok: true, server: {}, reflexive: { ip: "203.0.113.9", port: 40000 } }] });
    assert.equal(nat.natType, NatType.NO_NAT);
  });

  it("CONE when the mapping is consistent across servers", () => {
    const nat = classifyNat({
      hostAddresses: ["192.168.1.8"],
      stunResults: [
        { ok: true, server: { host: "a" }, reflexive: { ip: "203.0.113.9", port: 40000 } },
        { ok: true, server: { host: "b" }, reflexive: { ip: "203.0.113.9", port: 40000 } },
      ],
    });
    assert.equal(nat.natType, NatType.CONE);
    assert.equal(nat.symmetric, false);
    assert.equal(nat.portMapping.consistent, true);
  });

  it("SYMMETRIC when the mapped port differs across servers", () => {
    const nat = classifyNat({
      hostAddresses: ["192.168.1.8"],
      stunResults: [
        { ok: true, server: { host: "a" }, reflexive: { ip: "203.0.113.9", port: 40000 } },
        { ok: true, server: { host: "b" }, reflexive: { ip: "203.0.113.9", port: 40001 } },
      ],
    });
    assert.equal(nat.natType, NatType.SYMMETRIC);
    assert.equal(nat.symmetric, true);
  });

  it("BLOCKED when STUN was attempted but nothing responded", () => {
    const nat = classifyNat({ hostAddresses: ["192.168.1.8"], stunResults: [{ ok: false, server: {}, error: "timeout" }] });
    assert.equal(nat.natType, NatType.BLOCKED);
    assert.equal(nat.reachability.stunReachable, false);
  });

  it("UNKNOWN with no STUN data; reachability + diagnostics present", () => {
    const nat = classifyNat({ hostAddresses: ["192.168.1.8"], stunResults: [] });
    assert.equal(nat.natType, NatType.UNKNOWN);
    assert.equal(nat.reachability.inboundReachable, undefined); // only set once reachable
  });
});

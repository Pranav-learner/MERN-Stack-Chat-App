/**
 * Capability negotiation + Communication analysis + Network analysis tests (Layer 12, Sprint 2).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, makeClock, directRequest, mediaRequest, groupRequest } from "./helpers.js";
import { CapabilityEngine } from "../capability/capabilityEngine.js";
import { negotiateProfiles, createCapabilityProfile, supportsTransport } from "../capability/capabilityProfile.js";
import { CommunicationAnalyzer, classifyPayload } from "../analyzers/communicationAnalyzer.js";
import { NetworkAnalyzer } from "../analyzers/networkAnalyzer.js";
import { ContextBuilder, normalizeCommunicationRequest } from "../_fabric.js";
import { TransportCapability, Availability, NetworkSubstrate, PayloadClass } from "../types/types.js";
import { InvalidCapabilityError } from "../errors.js";

const ctxFor = (req) => new ContextBuilder({ clock: makeClock().now }).build(normalizeCommunicationRequest(req));

test("capability negotiation intersects transports + takes the min protocol version", () => {
  const sender = createCapabilityProfile({ identityId: "alice", protocolVersion: 3, transports: [TransportCapability.DIRECT, TransportCapability.RELAY, TransportCapability.SYNC_CHANNEL] });
  const receiver = createCapabilityProfile({ identityId: "bob", protocolVersion: 2, transports: [TransportCapability.DIRECT, TransportCapability.STORE_AND_FORWARD] });
  const negotiated = negotiateProfiles(sender, [receiver]);
  assert.deepEqual(negotiated.transports, [TransportCapability.DIRECT]);
  assert.equal(negotiated.protocolVersion, 2);
});

test("capability profiles are immutable + fingerprinted", () => {
  const p = createCapabilityProfile({ identityId: "alice" });
  assert.ok(p.fingerprint);
  assert.throws(() => {
    p.transports.push("x");
  });
});

test("capability engine falls back to a permissive baseline with no provider", () => {
  const engine = new CapabilityEngine();
  const { negotiated } = engine.collect({ senderId: "alice", receiverIds: ["bob"] });
  assert.ok(negotiated.transports.length > 0);
  assert.ok(supportsTransport(negotiated, TransportCapability.DIRECT));
});

test("capability engine uses an injected provider + caches profiles", () => {
  let calls = 0;
  const provider = (id) => {
    calls++;
    return { transports: [TransportCapability.DIRECT], features: ["e2e-encryption"], protocolVersion: 1 };
  };
  const engine = new CapabilityEngine({ capabilityProvider: provider });
  engine.collect({ senderId: "alice", receiverIds: [] });
  engine.collect({ senderId: "alice", receiverIds: [] });
  assert.ok(calls <= 1, "second collect for the same party should hit the cache");
  assert.ok(engine.stats().hits >= 1);
});

test("negotiation with no common transport throws", () => {
  const engine = new CapabilityEngine({
    capabilityProvider: (id) => (id === "alice" ? { transports: [TransportCapability.DIRECT] } : { transports: [TransportCapability.RELAY] }),
  });
  assert.throws(() => engine.collect({ senderId: "alice", receiverIds: ["bob"] }), InvalidCapabilityError);
});

test("communication analyzer normalizes type/media/priority/payload class", () => {
  const analysis = new CommunicationAnalyzer().analyze(ctxFor(mediaRequest({ payloadRef: { id: "m", size: 8 * 1024 * 1024 } })));
  assert.equal(analysis.isMedia, true);
  assert.equal(analysis.payloadClass, PayloadClass.LARGE);
  assert.equal(analysis.isLarge, true);
  assert.equal(analysis.isRealtime, false); // voice/video out of scope
});

test("communication analyzer detects group + sync needs", () => {
  const group = new CommunicationAnalyzer().analyze(ctxFor(groupRequest({ metadata: { memberCount: 40 } })));
  assert.equal(group.isGroup, true);
  assert.equal(group.groupSize, 40);
  const diverged = new CommunicationAnalyzer().analyze(ctxFor(directRequest({ sync: { state: "diverged" } })));
  assert.equal(diverged.needsSync, true);
});

test("payload classification thresholds", () => {
  assert.equal(classifyPayload("none", 0), PayloadClass.NONE);
  assert.equal(classifyPayload("image", 1024), PayloadClass.SMALL);
  assert.equal(classifyPayload("image", 1024 * 1024), PayloadClass.MEDIUM);
  assert.equal(classifyPayload("video", 50 * 1024 * 1024), PayloadClass.LARGE);
});

test("network analyzer defaults every substrate to available (no probing)", () => {
  const net = new NetworkAnalyzer().analyze(ctxFor(directRequest()));
  assert.equal(net.availability[NetworkSubstrate.P2P], Availability.AVAILABLE);
  assert.equal(net.probed, false);
  assert.equal(net.latencyMs, null, "latency is a Sprint-3 placeholder");
  assert.equal(net.bandwidthKbps, null);
});

test("network analyzer honours a per-request hint", () => {
  const net = new NetworkAnalyzer().analyze(ctxFor(directRequest()), { hint: { p2p: false, relay: true } });
  assert.equal(net.availability[NetworkSubstrate.P2P], Availability.UNAVAILABLE);
  assert.equal(net.availability[NetworkSubstrate.RELAY], Availability.AVAILABLE);
});

test("network analyzer honours an injected provider", () => {
  const net = new NetworkAnalyzer({ networkStateProvider: () => ({ p2p: false }) }).analyze(ctxFor(directRequest()));
  assert.equal(net.availability[NetworkSubstrate.P2P], Availability.UNAVAILABLE);
});

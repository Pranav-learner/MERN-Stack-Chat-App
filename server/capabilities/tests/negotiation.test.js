/**
 * Negotiation engine, version utility, transport policies, and advertisement tests
 * (Layer 6, Sprint 3). DB-free + mostly pure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseVersion,
  isValidVersion,
  compareVersions,
  versionsEqual,
  highestCommonVersion,
  maxVersion,
  normalizeVersions,
} from "../version/version.js";
import { negotiateCapabilities, negotiationKey } from "../negotiation/negotiation.js";
import {
  TransportPolicy,
  resolvePolicy,
  orderByPolicy,
  selectPreferredTransport,
  DEFAULT_TRANSPORT_POLICY,
} from "../policies/transportPolicy.js";
import { createCapabilityAdvertisement, createP2PPlaceholder } from "../advertisement/advertisement.js";
import { TransportType, CompressionType, CapabilityFailureReason } from "../types/types.js";

const dev = (over = {}) => ({
  userId: "u",
  deviceId: "d",
  version: 1,
  protocolVersions: ["1.0"],
  cryptoVersions: ["1.0"],
  transports: ["websocket", "relay"],
  compression: ["gzip", "none"],
  attachments: { supported: true, maxSize: 1000 },
  maxPayloadSize: 1000,
  relaySupport: true,
  connectionPreferences: ["websocket", "relay"],
  featureFlags: { typing: true },
  ...over,
});

// ---------------------------------------------------------------------------
describe("version utility", () => {
  it("parses + validates dotted versions", () => {
    assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
    assert.equal(parseVersion("x"), null);
    assert.ok(isValidVersion("2.0"));
    assert.ok(!isValidVersion(""));
    assert.ok(!isValidVersion("1.-1"));
  });

  it("compares with trailing-zero equivalence", () => {
    assert.equal(compareVersions("1.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.2", "1.10"), -1);
    assert.equal(compareVersions("2.0", "1.9"), 1);
    assert.ok(versionsEqual("1", "1.0.0"));
  });

  it("highestCommonVersion picks the max shared (or null)", () => {
    assert.equal(highestCommonVersion(["1.0", "1.1", "2.0"], ["1.1", "2.0"]), "2.0");
    assert.equal(highestCommonVersion(["1.0"], ["2.0"]), null);
    assert.equal(highestCommonVersion(["1.0", "1.0.0"], ["1.0"]), "1.0");
  });

  it("maxVersion + normalizeVersions", () => {
    assert.equal(maxVersion(["1.0", "2.1", "1.5"]), "2.1");
    assert.deepEqual(normalizeVersions(["2.0", "1.0", "2.0", "bad"]), ["1.0", "2.0"]);
  });
});

// ---------------------------------------------------------------------------
describe("transport policies", () => {
  it("resolves named + object + default policies", () => {
    assert.equal(resolvePolicy("prefer-relay").name, "prefer-relay");
    assert.equal(resolvePolicy(undefined), DEFAULT_TRANSPORT_POLICY);
    assert.equal(resolvePolicy("unknown-policy"), DEFAULT_TRANSPORT_POLICY);
    assert.equal(resolvePolicy({ name: "x", priority: ["relay"] }).name, "x");
  });

  it("orders shared transports by policy priority", () => {
    const shared = ["websocket", "relay", "webrtc"];
    assert.deepEqual(orderByPolicy(shared, TransportPolicy.AUTO), ["webrtc", "relay", "websocket"]);
    assert.deepEqual(orderByPolicy(shared, "prefer-websocket"), ["websocket", "relay", "webrtc"]);
    assert.deepEqual(orderByPolicy(shared, "prefer-relay"), ["relay", "websocket", "webrtc"]);
  });

  it("selects preferred + fallback chain", () => {
    const sel = selectPreferredTransport(["relay", "websocket"], "prefer-websocket");
    assert.equal(sel.preferredTransport, "websocket");
    assert.deepEqual(sel.fallbackChain, ["relay"]);
    assert.equal(sel.policy, "prefer-websocket");
    assert.equal(selectPreferredTransport([], "auto").preferredTransport, null);
  });

  it("unranked transports sort after ranked ones", () => {
    const ordered = orderByPolicy(["tcp", "relay"], "prefer-relay");
    assert.equal(ordered[0], "relay");
  });
});

// ---------------------------------------------------------------------------
describe("advertisement builder", () => {
  it("normalizes + applies defaults; p2p placeholder is inert", () => {
    const ad = createCapabilityAdvertisement({ transports: ["relay", "bogus", "relay"], compression: ["gzip"] });
    assert.deepEqual(ad.transports, ["relay"]); // unknown dropped, deduped
    assert.ok(ad.compression.includes("none")); // none floor always present
    assert.equal(ad.p2p.enabled, false);
    assert.equal(ad.p2p.reserved, true);
    assert.equal(createP2PPlaceholder().reserved, true);
  });

  it("drops non-boolean feature flags + empty transports fall back to websocket", () => {
    const ad = createCapabilityAdvertisement({ transports: [], featureFlags: { a: true, b: "nope" } });
    assert.deepEqual(ad.transports, [TransportType.WEBSOCKET]);
    assert.deepEqual(ad.featureFlags, { a: true });
  });
});

// ---------------------------------------------------------------------------
describe("negotiation engine — compatibility", () => {
  it("negotiates highest common versions, shared transports, min payload, AND-ed flags", () => {
    const a = dev({ transports: ["webrtc", "websocket", "relay"], compression: ["brotli", "gzip"], maxPayloadSize: 2000, featureFlags: { typing: true, reactions: true } });
    const b = dev({ userId: "v", transports: ["websocket", "relay"], compression: ["gzip"], maxPayloadSize: 500, featureFlags: { typing: true, receipts: true } });
    const r = negotiateCapabilities(a, b);
    assert.equal(r.compatible, true);
    assert.equal(r.protocolVersion, "1.0");
    assert.equal(r.cryptoVersion, "1.0");
    assert.deepEqual(r.sharedTransports, ["relay", "websocket"]); // sorted
    assert.equal(r.preferredTransport, "relay"); // AUTO: relay beats websocket
    assert.deepEqual(r.fallbackChain, ["websocket"]);
    assert.equal(r.compression, "gzip"); // best shared
    assert.equal(r.maxPayloadSize, 500); // min
    assert.deepEqual(r.featureFlags, { typing: true }); // only the shared-enabled flag
    assert.equal(r.relay, true);
  });

  it("is symmetric: negotiate(A,B) matches negotiate(B,A) on shared fields", () => {
    const a = dev({ transports: ["websocket", "relay", "quic"] });
    const b = dev({ userId: "v", transports: ["relay", "websocket"] });
    const rAB = negotiateCapabilities(a, b);
    const rBA = negotiateCapabilities(b, a);
    assert.deepEqual(rAB.sharedTransports, rBA.sharedTransports);
    assert.equal(rAB.preferredTransport, rBA.preferredTransport);
    assert.equal(rAB.protocolVersion, rBA.protocolVersion);
    assert.equal(rAB.compression, rBA.compression);
  });

  it("applies the requested transport policy", () => {
    const a = dev({ transports: ["webrtc", "websocket", "relay"] });
    const b = dev({ userId: "v", transports: ["webrtc", "websocket", "relay"] });
    assert.equal(negotiateCapabilities(a, b, { policy: "prefer-relay" }).preferredTransport, "relay");
    assert.equal(negotiateCapabilities(a, b, { policy: "prefer-websocket" }).preferredTransport, "websocket");
    assert.equal(negotiateCapabilities(a, b, { policy: "prefer-webrtc" }).preferredTransport, "webrtc");
  });

  it("compression prefers the most capable shared algorithm", () => {
    const a = dev({ compression: ["brotli", "gzip", "none"] });
    const b = dev({ userId: "v", compression: ["gzip", "none"] });
    assert.equal(negotiateCapabilities(a, b).compression, "gzip");
    assert.equal(negotiateCapabilities(dev({ compression: ["none"] }), dev({ userId: "v", compression: ["none"] })).compression, CompressionType.NONE);
  });
});

// ---------------------------------------------------------------------------
describe("negotiation engine — incompatibility", () => {
  it("fails on incompatible protocol version", () => {
    const r = negotiateCapabilities(dev({ protocolVersions: ["1.0"] }), dev({ userId: "v", protocolVersions: ["2.0"] }));
    assert.equal(r.compatible, false);
    assert.equal(r.failureReason, CapabilityFailureReason.INCOMPATIBLE_PROTOCOL_VERSION);
  });

  it("fails on incompatible crypto version", () => {
    const r = negotiateCapabilities(dev({ cryptoVersions: ["1.0"] }), dev({ userId: "v", cryptoVersions: ["9.9"] }));
    assert.equal(r.failureReason, CapabilityFailureReason.INCOMPATIBLE_CRYPTO_VERSION);
  });

  it("fails on no shared transport", () => {
    const r = negotiateCapabilities(dev({ transports: ["websocket"] }), dev({ userId: "v", transports: ["quic"] }));
    assert.equal(r.compatible, false);
    assert.equal(r.failureReason, CapabilityFailureReason.NO_SHARED_TRANSPORT);
    assert.equal(r.preferredTransport, null);
  });

  it("protocol failure is reported before transport failure (most-fundamental first)", () => {
    const r = negotiateCapabilities(dev({ protocolVersions: ["1.0"], transports: ["websocket"] }), dev({ userId: "v", protocolVersions: ["3.0"], transports: ["quic"] }));
    assert.equal(r.failureReason, CapabilityFailureReason.INCOMPATIBLE_PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
describe("negotiationKey — version-aware + order-independent", () => {
  it("same pair + versions → same key regardless of argument order", () => {
    const a = dev({ userId: "a", deviceId: "1", version: 3 });
    const b = dev({ userId: "b", deviceId: "1", version: 5 });
    assert.equal(negotiationKey(a, b, "auto"), negotiationKey(b, a, "auto"));
  });

  it("a version bump changes the key (→ cache naturally invalidates)", () => {
    const a1 = dev({ userId: "a", deviceId: "1", version: 1 });
    const a2 = dev({ userId: "a", deviceId: "1", version: 2 });
    const b = dev({ userId: "b", deviceId: "1", version: 1 });
    assert.notEqual(negotiationKey(a1, b, "auto"), negotiationKey(a2, b, "auto"));
  });

  it("policy is part of the key", () => {
    const a = dev({ userId: "a" });
    const b = dev({ userId: "b" });
    assert.notEqual(negotiationKey(a, b, "auto"), negotiationKey(a, b, "prefer-relay"));
  });
});

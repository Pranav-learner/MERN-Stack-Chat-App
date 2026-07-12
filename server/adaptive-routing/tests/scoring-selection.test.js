/**
 * Route scoring + adaptive strategy selection tests (Layer 12, Sprint 2). Verifies the routing decision
 * emerges from weighted scores (no conditionals): direct wins when p2p is up, relay wins adaptively when
 * p2p is down, media/group/sync select correctly, capability + availability gate candidates, and weights
 * are configurable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, directRequest, mediaRequest, groupRequest, syncRequest, countEvents } from "./helpers.js";
import { RouteScoringEngine } from "../scoring/routeScoringEngine.js";
import { AdaptiveEventType, StrategyType, RouteKind, ScoreDimension, TransportCapability } from "../types/types.js";

test("direct wins when p2p is available", async () => {
  const { api } = makeEngine();
  const best = await api.getBestRoute(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  assert.equal(best.selection.strategy, StrategyType.DIRECT);
  assert.equal(best.selection.route, RouteKind.DIRECT_TRANSPORT);
});

test("relay wins ADAPTIVELY when the recipient is online but p2p is down (no force, no conditional)", async () => {
  // recipient reachable (online) ⇒ deliver now via relay beats delaying via store-and-forward
  const { api } = makeEngine();
  const best = await api.getBestRoute(directRequest({ availability: { status: "online" }, network: { p2p: false, relay: true } }), { callerId: "alice" });
  assert.equal(best.selection.strategy, StrategyType.RELAY);
  assert.equal(best.selection.route, RouteKind.RELAYED_TRANSPORT);
  assert.equal(best.selection.adaptive, true, "relay was injected as an adaptive candidate");
});

test("offline store-and-forward wins when the recipient is offline", async () => {
  const { api } = makeEngine();
  const best = await api.getBestRoute(directRequest({ availability: { status: "offline" }, network: { p2p: false } }), { callerId: "alice" });
  assert.equal(best.selection.route, RouteKind.STORE_AND_FORWARD);
});

test("media selects the media pipeline; group selects fan-out; sync selects the sync channel", async () => {
  const { api } = makeEngine();
  assert.equal((await api.getBestRoute(mediaRequest(), { callerId: "alice" })).selection.strategy, StrategyType.MEDIA);
  assert.equal((await api.getBestRoute(groupRequest(), { callerId: "alice" })).selection.strategy, StrategyType.GROUP);
  assert.equal((await api.getBestRoute(syncRequest(), { callerId: "alice" })).selection.strategy, StrategyType.SYNCHRONIZATION);
});

test("a route is hard-vetoed when its transport substrate is unavailable", async () => {
  // direct-transport (p2p) AND relay both down → direct/relay non-viable, store-and-forward (transport) wins
  const { api } = makeEngine();
  const scores = await api.getRouteScores(directRequest({ network: { p2p: false, relay: false } }), { callerId: "alice" });
  const direct = scores.find((s) => s.route === RouteKind.DIRECT_TRANSPORT);
  assert.equal(direct.viable, false, "direct should be non-viable with p2p down");
});

test("capability mismatch hard-fails a candidate", async () => {
  // sender/receiver only support store-and-forward → direct is non-viable by capability
  const provider = () => ({ transports: [TransportCapability.STORE_AND_FORWARD], features: ["e2e-encryption"], protocolVersion: 1 });
  const { api } = makeEngine({ providers: { capability: provider } });
  const scores = await api.getRouteScores(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  const direct = scores.find((s) => s.route === RouteKind.DIRECT_TRANSPORT);
  assert.equal(direct.viable, false);
});

test("scoring weights are configurable", async () => {
  // crank COST weight to the max and zero the rest → cheapest route (direct) dominates
  const { api } = makeEngine({ config: { weights: { [ScoreDimension.COST]: 10, [ScoreDimension.TRANSPORT_AVAILABILITY]: 0, [ScoreDimension.SECURITY]: 0, [ScoreDimension.CAPABILITY_MATCH]: 0, [ScoreDimension.POLICY_MATCH]: 0, [ScoreDimension.SYNC_NEEDS]: 0 } } });
  const scores = await api.getRouteScores(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  assert.equal(scores[0].route, RouteKind.DIRECT_TRANSPORT);
});

test("ranked scores are ordered viable-first, then by total", async () => {
  const { api } = makeEngine();
  const scores = await api.getRouteScores(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  for (let i = 1; i < scores.length; i++) {
    if (scores[i - 1].viable === scores[i].viable) assert.ok(scores[i - 1].total >= scores[i].total, "totals should be descending within a viability class");
    else assert.ok(scores[i - 1].viable, "viable routes come first");
  }
});

test("scoring emits a RoutesScored event with the full ranking", async () => {
  const { api, captured } = makeEngine();
  await api.getBestRoute(directRequest(), { callerId: "alice" });
  assert.ok(countEvents(captured, AdaptiveEventType.ROUTES_SCORED) >= 1);
  assert.ok(countEvents(captured, AdaptiveEventType.STRATEGY_SELECTED) >= 1);
});

test("the scoring engine is pure (same input → same ranking)", async () => {
  const { api } = makeEngine();
  const a = await api.getRouteScores(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  const b = await api.getRouteScores(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  assert.deepEqual(a.map((s) => s.route), b.map((s) => s.route));
});

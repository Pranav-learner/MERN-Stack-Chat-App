/**
 * Decision Engine + Context building tests (Layer 12, Sprint 1). Verifies the context is complete +
 * immutable, and that the engine selects strategies through the interface (not conditionals) across
 * conversation shapes, media, availability, sync posture, and priority.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFabric, makeClock, directRequest, groupRequest, mediaRequest, syncRequest } from "./helpers.js";
import { ContextBuilder } from "../contexts/contextBuilder.js";
import { normalizeCommunicationRequest } from "../dto/dto.js";
import { StrategyType, RouteKind, RecipientAvailability, SyncState, ConversationType } from "../types/types.js";

test("context is complete + deeply immutable", async () => {
  const builder = new ContextBuilder({ clock: makeClock().now });
  const ctx = builder.build(normalizeCommunicationRequest(directRequest({ requestId: "r1" })));
  for (const facet of ["conversation", "media", "recipient", "synchronization", "security", "transport", "execution", "diagnostics"]) {
    assert.ok(ctx.raw[facet], `missing facet ${facet}`);
  }
  assert.throws(() => {
    ctx.raw.conversation.type = "hacked";
  }, "context must be frozen");
  assert.equal(ctx.isGroup(), false);
  assert.equal(ctx.hasMedia(), false);
});

test("direct online 1:1 text selects the DIRECT strategy over DIRECT_TRANSPORT", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(directRequest({ availability: { status: RecipientAvailability.ONLINE } }), { callerId: "alice" });
  assert.equal(decision.strategy, StrategyType.DIRECT);
  assert.equal(decision.route, RouteKind.DIRECT_TRANSPORT);
});

test("offline recipient selects the OFFLINE store-and-forward strategy", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(directRequest({ availability: { status: RecipientAvailability.OFFLINE } }), { callerId: "alice" });
  assert.equal(decision.strategy, StrategyType.OFFLINE);
  assert.equal(decision.route, RouteKind.STORE_AND_FORWARD);
});

test("group message selects the GROUP fan-out strategy", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(groupRequest(), { callerId: "alice" });
  assert.equal(decision.strategy, StrategyType.GROUP);
  assert.equal(decision.route, RouteKind.GROUP_FANOUT);
  assert.ok(decision.subsystems.includes("group"));
});

test("media request selects the MEDIA strategy regardless of conversation", async () => {
  const { api } = makeFabric();
  const direct = await api.getStrategy(mediaRequest(), { callerId: "alice" });
  assert.equal(direct.strategy, StrategyType.MEDIA);
  const group = await api.getStrategy(mediaRequest({ groupId: "g1", recipients: undefined }), { callerId: "alice" });
  assert.equal(group.strategy, StrategyType.MEDIA);
  assert.ok(group.subsystems.includes("group"));
});

test("synchronization / self conversation selects the SYNC strategy", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(syncRequest(), { callerId: "alice" });
  assert.equal(decision.strategy, StrategyType.SYNCHRONIZATION);
  assert.equal(decision.route, RouteKind.SYNC_CHANNEL);
});

test("a diverged replica attaches a sync constraint to a direct send", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(directRequest({ availability: { status: RecipientAvailability.ONLINE }, sync: { state: SyncState.DIVERGED } }), { callerId: "alice" });
  assert.equal(decision.strategy, StrategyType.DIRECT);
  assert.equal(decision.constraints.requireSyncStep, true);
});

test("decision carries an ordered reason audit + confidence", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(directRequest({ availability: { status: RecipientAvailability.ONLINE } }), { callerId: "alice" });
  assert.ok(Array.isArray(decision.reasons) && decision.reasons.length > 0);
  assert.ok(["definitive", "likely", "tentative"].includes(decision.confidence));
});

test("unknown availability is handled conservatively (still decides)", async () => {
  const { api } = makeFabric();
  const decision = await api.getStrategy(directRequest(), { callerId: "alice" });
  assert.ok([StrategyType.DIRECT, StrategyType.OFFLINE].includes(decision.strategy));
});

test("conversation type is inferred: multiple recipients ⇒ broadcast", async () => {
  const req = normalizeCommunicationRequest({ type: "direct-message", senderId: "alice", recipients: ["bob", "carol"] });
  assert.equal(req.conversationType, ConversationType.BROADCAST);
});

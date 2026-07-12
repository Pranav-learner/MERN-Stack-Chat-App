/**
 * Strategy framework + Policy framework + validation tests (Layer 12, Sprint 1). Verifies strategy
 * registration/selection through interfaces, policy bias/denial/config, placeholder inertness, and the
 * validation surface (invalid request, unsupported voice/video, authorization, no-content invariant).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFabric, directRequest, groupRequest, mediaRequest } from "./helpers.js";
import { createDefaultStrategyRegistry } from "../strategies/index.js";
import { PolicyEngine } from "../policies/policyEngine.js";
import { ContextBuilder } from "../contexts/contextBuilder.js";
import { normalizeCommunicationRequest } from "../dto/dto.js";
import { assertNoContent, validateRequest } from "../validators/validators.js";
import { StrategyType, MediaType } from "../types/types.js";
import { ContentLeakError, UnsupportedCommunicationError, UnauthorizedFabricError, PolicyDeniedError, InvalidRequestError } from "../errors.js";

test("strategy registry lists every strategy in priority order", () => {
  const reg = createDefaultStrategyRegistry();
  assert.deepEqual(reg.types(), [StrategyType.MEDIA, StrategyType.GROUP, StrategyType.SYNCHRONIZATION, StrategyType.DIRECT, StrategyType.OFFLINE, StrategyType.RELAY, StrategyType.HYBRID]);
});

test("placeholder strategies (relay/hybrid) never win unless explicitly forced", async () => {
  const { api } = makeFabric();
  const normal = await api.getStrategy(directRequest({ availability: { status: "online" } }), { callerId: "alice" });
  assert.notEqual(normal.strategy, StrategyType.RELAY);
  const forced = await api.getStrategy(directRequest({ availability: { status: "online" }, metadata: { forceRelay: true } }), { callerId: "alice" });
  assert.equal(forced.strategy, StrategyType.RELAY);
});

test("media policy denies a disallowed media type", async () => {
  const { api } = makeFabric({ policyConfig: { media: { allowedTypes: [MediaType.DOCUMENT] } } });
  await assert.rejects(() => api.execute(mediaRequest({ mediaType: "image" }), { callerId: "alice" }), PolicyDeniedError);
});

test("media policy denies over-size media", async () => {
  const { api } = makeFabric({ policyConfig: { media: { maxSizeBytes: 100 } } });
  await assert.rejects(() => api.execute(mediaRequest({ payloadRef: { id: "m", size: 999 } }), { callerId: "alice" }), PolicyDeniedError);
});

test("messaging policy caps recipient fan-out", async () => {
  const { api } = makeFabric({ policyConfig: { messaging: { maxRecipients: 1 } } });
  await assert.rejects(() => api.execute(directRequest({ recipients: ["a", "b", "c"] }), { callerId: "alice" }), PolicyDeniedError);
});

test("group policy requires a groupId", async () => {
  const { manager } = makeFabric();
  // a group conversation type with no groupId is caught at request validation first
  await assert.rejects(() => manager.execute({ type: "group-message", senderId: "alice", conversationType: "group" }, { callerId: "alice" }), InvalidRequestError);
});

test("policy engine evaluate returns bias + refs without executing", async () => {
  const events = undefined;
  const engine = new PolicyEngine();
  const ctx = new ContextBuilder().build(normalizeCommunicationRequest(groupRequest()));
  const result = engine.evaluate(ctx);
  assert.ok(result.policyRefs.includes("group.fanout-guard"));
  assert.equal(result.denied, null);
});

test("security policy can require a ready secure session", async () => {
  const { api } = makeFabric({ policyConfig: { security: { requireSecureSession: true } } });
  await assert.rejects(() => api.execute(directRequest({ security: { sessionReady: false } }), { callerId: "alice" }), PolicyDeniedError);
});

test("validation rejects an unknown communication type", () => {
  assert.throws(() => validateRequest(normalizeCommunicationRequest({ type: "telepathy", senderId: "a", recipients: ["b"] })), InvalidRequestError);
});

test("voice/video are declared but unsupported this sprint", async () => {
  const { api } = makeFabric();
  await assert.rejects(() => api.execute({ type: "voice", senderId: "alice", recipients: ["bob"] }, { callerId: "alice" }), UnsupportedCommunicationError);
});

test("authorization: caller must be the sender", async () => {
  const { api } = makeFabric();
  await assert.rejects(() => api.execute(directRequest({ senderId: "alice" }), { callerId: "mallory" }), UnauthorizedFabricError);
});

test("no-content invariant: a request smuggling content is rejected", async () => {
  const { api } = makeFabric();
  await assert.rejects(() => api.execute({ type: "direct-message", senderId: "alice", recipients: ["bob"], metadata: { plaintext: "secret" } }, { callerId: "alice" }), ContentLeakError);
});

test("assertNoContent flags forbidden fields at any depth", () => {
  assert.throws(() => assertNoContent({ a: { b: { sessionKey: "x" } } }), ContentLeakError);
  assert.doesNotThrow(() => assertNoContent({ a: { b: { id: "x", count: 3 } } }));
});

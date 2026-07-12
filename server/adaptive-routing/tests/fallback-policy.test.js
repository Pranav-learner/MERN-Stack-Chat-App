/**
 * Fallback planning + Policy evaluation (hooks) tests (Layer 12, Sprint 2). Verifies deterministic
 * fallback plans, policy-driven bias/veto, the data-saver / battery-saver / enterprise / security hooks,
 * and denial.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, directRequest, mediaRequest } from "./helpers.js";
import { PolicyEvaluationEngine } from "../evaluators/policyEvaluationEngine.js";
import { CommunicationAnalyzer } from "../analyzers/communicationAnalyzer.js";
import { ContextBuilder, normalizeCommunicationRequest, PolicyDeniedError } from "../_fabric.js";
import { RouteKind, StrategyType, AdaptiveEventType } from "../types/types.js";
import { PolicyConflictError } from "../errors.js";

const analyze = (req) => {
  const ctx = new ContextBuilder().build(normalizeCommunicationRequest(req));
  return { ctx, analysis: new CommunicationAnalyzer().analyze(ctx) };
};

test("fallback plan is deterministic + lists lower-ranked alternatives", async () => {
  const { api } = makeEngine();
  const fb1 = await api.getFallbackPlan(directRequest({ network: { p2p: true, relay: true } }), { callerId: "alice" });
  const fb2 = await api.getFallbackPlan(directRequest({ network: { p2p: true, relay: true } }), { callerId: "alice" });
  assert.deepEqual(fb1.fallbacks.map((f) => f.routeKind), fb2.fallbacks.map((f) => f.routeKind));
  assert.ok(fb1.retryPolicy.maxAttempts >= 1);
  assert.equal(fb1.failureMetadata.deterministic, true);
});

test("fallback plan appends a store-and-forward safety net for messaging", async () => {
  const { api } = makeEngine();
  const fb = await api.getFallbackPlan(directRequest({ network: { p2p: true, relay: true } }), { callerId: "alice" });
  assert.ok(fb.fallbacks.some((f) => f.routeKind === RouteKind.STORE_AND_FORWARD), "offline safety net present");
});

test("data-saver hook vetoes relayed transport for large payloads", async () => {
  const engine = new PolicyEvaluationEngine({ config: { dataSaver: { enabled: true } } });
  const { ctx, analysis } = analyze(mediaRequest({ payloadRef: { id: "m", size: 50 * 1024 * 1024 } }));
  const result = engine.evaluate(ctx, analysis);
  assert.ok(result.vetoRoutes.includes(RouteKind.RELAYED_TRANSPORT));
  assert.ok(result.policyRefs.includes("hook.data-saver"));
});

test("enterprise hook can force-relay (veto direct)", async () => {
  const engine = new PolicyEvaluationEngine({ config: { enterprise: { forceRelay: true } } });
  const { ctx, analysis } = analyze(directRequest());
  const result = engine.evaluate(ctx, analysis);
  assert.ok(result.vetoRoutes.includes(RouteKind.DIRECT_TRANSPORT));
  assert.ok((result.bias[StrategyType.RELAY] ?? 0) > 0);
});

test("enterprise force-relay makes the engine select relay end-to-end", async () => {
  const { api } = makeEngine({ config: { policyConfig: { enterprise: { forceRelay: true } } } });
  const best = await api.getBestRoute(directRequest({ network: { p2p: true, relay: true } }), { callerId: "alice" });
  assert.equal(best.selection.route, RouteKind.RELAYED_TRANSPORT);
});

test("battery-saver hook is bypassed for urgent traffic", async () => {
  const engine = new PolicyEvaluationEngine({ config: { batterySaver: { enabled: true } } });
  const { ctx, analysis } = analyze(directRequest({ priority: "urgent" }));
  const result = engine.evaluate(ctx, analysis);
  assert.equal(result.vetoRoutes.length, 0);
});

test("security hook denies when a secure session is required but not ready", async () => {
  const { api } = makeEngine({ config: { policyConfig: { security: { requireSecureSession: true } } } });
  await assert.rejects(() => api.evaluate(directRequest({ security: { sessionReady: false } }), { callerId: "alice" }), PolicyDeniedError);
});

test("security direct-only posture vetoes relay", async () => {
  const engine = new PolicyEvaluationEngine({ config: { security: { directOnly: true } } });
  const { ctx, analysis } = analyze(directRequest());
  const result = engine.evaluate(ctx, analysis);
  assert.ok(result.vetoRoutes.includes(RouteKind.RELAYED_TRANSPORT));
});

test("a Sprint-1 policy denial still applies (recipient cap)", async () => {
  const { api } = makeEngine({ config: { policyConfig: { messaging: { maxRecipients: 1 } } } });
  await assert.rejects(() => api.evaluate(directRequest({ recipients: ["a", "b", "c"] }), { callerId: "alice" }), PolicyDeniedError);
});

test("policy evaluation emits a PoliciesEvaluated event", async () => {
  const { api, captured } = makeEngine();
  await api.getBestRoute(directRequest(), { callerId: "alice" });
  assert.ok(captured.some((e) => e.type === AdaptiveEventType.POLICIES_EVALUATED));
});

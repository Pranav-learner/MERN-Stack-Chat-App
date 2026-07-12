/**
 * Performance + concurrency + regression tests (Layer 12, Sprint 1). Verifies the decision cache
 * memoizes semantically-identical requests, many concurrent requests execute independently + correctly,
 * and a mixed workload stays internally consistent (every execution persisted, no cross-talk).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFabric, directRequest, groupRequest, mediaRequest, syncRequest } from "./helpers.js";
import { DecisionCache } from "../manager/decisionCache.js";
import { ExecutionStatus } from "../types/types.js";

test("the decision cache memoizes identical decision inputs", async () => {
  const { manager } = makeFabric();
  const a = directRequest({ availability: { status: "online" } });
  await manager.execute({ ...a, requestId: "r1" }, { callerId: "alice" });
  await manager.execute({ ...a, requestId: "r2" }, { callerId: "alice" });
  const stats = manager.decisionCache.stats();
  assert.ok(stats.hits >= 1, "second identical request should hit the cache");
});

test("cache hit re-stamps a fresh decisionId per request (no identity conflation)", async () => {
  const { manager } = makeFabric();
  const req = directRequest({ availability: { status: "online" } });
  const d1 = await manager.getDecision({ ...req, requestId: "ra" }, { callerId: "alice" });
  const d2 = await manager.getDecision({ ...req, requestId: "rb" }, { callerId: "alice" });
  assert.notEqual(d1.decisionId, d2.decisionId);
  assert.equal(d1.strategy, d2.strategy);
});

test("DecisionCache honours TTL expiry + LRU bound", () => {
  let t = 0;
  const cache = new DecisionCache({ ttlMs: 10, max: 2, clock: () => t });
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  t = 11;
  assert.equal(cache.get("a"), undefined, "entry should expire");
  t = 20;
  cache.set("x", 1);
  cache.set("y", 2);
  cache.set("z", 3); // evicts x (LRU)
  assert.equal(cache.get("x"), undefined);
  assert.equal(cache.get("z"), 3);
});

test("100 concurrent direct requests all execute correctly + persist", async () => {
  const { manager, repo } = makeFabric();
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(manager.execute(directRequest({ requestId: `c${i}`, senderId: "alice", availability: { status: "online" } }), { callerId: "alice" }));
  const results = await Promise.all(jobs);
  assert.equal(results.length, 100);
  assert.ok(results.every((r) => r.status === ExecutionStatus.COMPLETED));
  assert.equal(repo._counts().executions, 100);
});

test("a mixed concurrent workload stays internally consistent", async () => {
  const { manager, repo } = makeFabric();
  const jobs = [];
  for (let i = 0; i < 40; i++) {
    jobs.push(manager.execute(directRequest({ requestId: `d${i}`, availability: { status: "online" } }), { callerId: "alice" }));
    jobs.push(manager.execute(groupRequest({ requestId: `g${i}` }), { callerId: "alice" }));
    jobs.push(manager.execute(mediaRequest({ requestId: `m${i}` }), { callerId: "alice" }));
    jobs.push(manager.execute(syncRequest({ requestId: `s${i}` }), { callerId: "alice" }));
  }
  const results = await Promise.all(jobs);
  assert.equal(results.length, 160);
  // every execution reached a terminal status + was persisted
  assert.ok(results.every((r) => [ExecutionStatus.COMPLETED, ExecutionStatus.PARTIAL].includes(r.status)));
  assert.equal(repo._counts().executions, 160);
  // strategies were selected correctly per type (regression: no cross-talk)
  assert.equal(results.filter((r) => r.decision.strategy === "group").length, 40);
  assert.equal(results.filter((r) => r.decision.strategy === "media").length, 40);
  assert.equal(results.filter((r) => r.decision.strategy === "synchronization").length, 40);
});

test("dry-run planning under concurrency never executes", async () => {
  const { manager, repo } = makeFabric();
  const jobs = [];
  for (let i = 0; i < 50; i++) jobs.push(manager.getExecutionPlan(directRequest({ requestId: `p${i}`, availability: { status: "online" } }), { callerId: "alice" }));
  const plans = await Promise.all(jobs);
  assert.ok(plans.every((p) => p.steps.length >= 1));
  assert.equal(repo._counts().executions, 0);
});

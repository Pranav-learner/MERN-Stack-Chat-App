/**
 * QoS classification + Communication scheduling tests (Layer 12, Sprint 3). Verifies priority classes,
 * lane isolation, adaptive priority (policy overrides), starvation-preventing aging, and the scheduling
 * modes (immediate / deferred / background / batch), including deterministic weighted-fair dispatch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOptimizer, makeClock, directRequest, groupRequest, mediaRequest, syncRequest, urgentRequest, countEvents } from "./helpers.js";
import { QoSManager } from "../qos/qosManager.js";
import { CommunicationScheduler } from "../scheduler/scheduler.js";
import { QoSClass, SchedulingMode, ScheduleStatus, OptimizationEventType } from "../types/types.js";

test("urgent/control communication is classified CRITICAL + immediate", async () => {
  const { api } = makeOptimizer();
  const r = await api.schedule(urgentRequest(), { callerId: "alice" });
  assert.equal(r.qos.qosClass, QoSClass.CRITICAL);
  assert.equal(r.scheduling.status, ScheduleStatus.IMMEDIATE);
  assert.equal(r.proceed, true);
});

test("synchronization is classified BACKGROUND + deferred", async () => {
  const { api } = makeOptimizer();
  const r = await api.schedule(syncRequest(), { callerId: "alice" });
  assert.equal(r.qos.qosClass, QoSClass.BACKGROUND);
  assert.equal(r.scheduling.mode, SchedulingMode.BACKGROUND);
  assert.equal(r.proceed, false);
});

test("large media is scheduled as a BATCH (deferred)", async () => {
  const { api } = makeOptimizer();
  const r = await api.schedule(mediaRequest(), { callerId: "alice" });
  assert.equal(r.scheduling.mode, SchedulingMode.BATCH);
  assert.equal(r.proceed, false);
});

test("normal direct message runs immediately", async () => {
  const { api } = makeOptimizer();
  const r = await api.schedule(directRequest(), { callerId: "alice" });
  assert.equal(r.qos.qosClass, QoSClass.NORMAL);
  assert.equal(r.scheduling.status, ScheduleStatus.IMMEDIATE);
});

test("QoS lanes are isolated (each class → its own lane)", () => {
  const qos = new QoSManager();
  const analysis = (priority) => ({ priority, communicationType: "direct-message", isMedia: false, isSelf: false });
  assert.equal(qos.evaluate({ analysis: analysis("urgent") }).lane, "critical");
  assert.equal(qos.evaluate({ analysis: analysis("high") }).lane, "high");
  assert.equal(qos.evaluate({ analysis: analysis("normal") }).lane, "normal");
  assert.equal(qos.evaluate({ analysis: analysis("low") }).lane, "background");
});

test("a CRITICAL classification cannot be downgraded by a later policy", () => {
  const qos = new QoSManager();
  // urgent sync: communication policy → critical (locked); sync policy would downgrade to background
  const decision = qos.evaluate({ analysis: { priority: "urgent", communicationType: "synchronization", isSelf: true, isMedia: false } });
  assert.equal(decision.qosClass, QoSClass.CRITICAL);
});

test("scheduler dispatch is weighted-fair (higher lanes first)", () => {
  const clock = makeClock();
  const scheduler = new CommunicationScheduler({ clock: clock.now });
  const enqueue = (id, lane) => scheduler.schedule({ requestId: id, qos: { qosClass: lane, lane }, analysis: {}, resources: { constrained: [] }, request: { mode: "deferred" } });
  enqueue("bg1", "background");
  enqueue("hi1", "high");
  enqueue("no1", "normal");
  const dispatched = scheduler.dispatch({ maxConcurrent: 3 });
  assert.equal(dispatched[0].requestId, "hi1", "highest-weight lane dispatched first");
});

test("aging prevents starvation (an old background item overtakes a fresh normal item)", () => {
  const clock = makeClock();
  const scheduler = new CommunicationScheduler({ clock: clock.now });
  scheduler.schedule({ requestId: "bg-old", qos: { qosClass: "background", lane: "background" }, analysis: {}, resources: { constrained: [] }, request: { mode: "background" } });
  clock.advance(60_000); // background item waits a long time → ages up
  scheduler.schedule({ requestId: "no-new", qos: { qosClass: "normal", lane: "normal" }, analysis: {}, resources: { constrained: [] }, request: { mode: "deferred" } });
  const dispatched = scheduler.dispatch({ maxConcurrent: 1 });
  assert.equal(dispatched[0].requestId, "bg-old", "aged background item should be picked first");
});

test("scheduling emits scheduled/deferred events", async () => {
  const { api, captured } = makeOptimizer();
  await api.schedule(urgentRequest(), { callerId: "alice" });
  await api.schedule(syncRequest(), { callerId: "alice" });
  assert.ok(countEvents(captured, OptimizationEventType.EXECUTION_SCHEDULED) >= 1);
  assert.ok(countEvents(captured, OptimizationEventType.EXECUTION_DEFERRED) >= 1);
});

test("an explicit requested mode is honoured", async () => {
  const { api } = makeOptimizer();
  const r = await api.schedule(directRequest({ mode: "deferred" }), { callerId: "alice" });
  assert.equal(r.scheduling.mode, SchedulingMode.DEFERRED);
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EvolutionPolicyExecutor } from "../policies/policyExecutor.js";
import { ForwardSecrecyEventType } from "../types/types.js";
import { makeManager, start, captureEvents, makeSessionId } from "./helpers.js";
// Import specific files (not the index barrel) to avoid loading the Mongo model/mongoose.
import { EvolutionManager } from "../../session-evolution/manager/evolutionManager.js";
import { createInMemoryEvolutionRepository } from "../../session-evolution/repository/inMemoryEvolutionRepository.js";
import { EvolutionScheduler } from "../../session-evolution/schedulers/scheduler.js";
import { EvolutionEventBus } from "../../session-evolution/events/events.js";
import { createTimeBasedPolicy } from "../../session-evolution/policies/policies.js";

/** Build a device FS manager wired to a Sprint 1 EvolutionManager sharing a clock. */
function makeWiredStack(options = {}) {
  const fs = makeManager(options);
  const evolution = new EvolutionManager({
    ...createInMemoryEvolutionRepository(),
    events: new EvolutionEventBus(),
    scheduler: new EvolutionScheduler({ clock: fs.clock }),
    clock: fs.clock,
  });
  fs.manager.evolution = evolution; // inject so evolve() also advances evolution generations
  const executor = new EvolutionPolicyExecutor({ forwardSecrecy: fs.manager, evolution });
  return { ...fs, evolution, executor };
}

describe("policy execution drives real generation advancement", () => {
  let stack;
  beforeEach(() => {
    stack = makeWiredStack();
  });

  it("manual execution evolves the session (and syncs the evolution generation)", async () => {
    const s = await start(stack.manager);
    await stack.evolution.createEvolutionState({ sessionId: s.sessionId, handshakeId: "hs-000001" });
    const dto = await stack.executor.executeManual(s.sessionId, { reason: "manual rotate" });
    assert.equal(dto.currentGeneration, 1);
    // the Sprint 1 evolution generation advanced in lockstep
    assert.equal((await stack.evolution.getStatus(s.sessionId)).generation, 1);
  });

  it("policy evaluation triggers evolution only when a policy fires", async () => {
    const { seen } = captureEvents(stack.events);
    const s = await start(stack.manager);
    await stack.evolution.createEvolutionState({ sessionId: s.sessionId });
    await stack.evolution.attachPolicy(s.sessionId, createTimeBasedPolicy({ intervalMs: 1000 }));

    let result = await stack.executor.executePolicies(s.sessionId);
    assert.equal(result.evolved, false, "not yet due");

    stack.clock.advance(1000);
    result = await stack.executor.executePolicies(s.sessionId);
    assert.equal(result.evolved, true);
    assert.equal(result.state.currentGeneration, 1);
    assert.ok(seen.types().includes(ForwardSecrecyEventType.POLICY_TRIGGERED));
  });

  it("security-triggered evolution rotates immediately", async () => {
    const s = await start(stack.manager);
    await stack.evolution.createEvolutionState({ sessionId: s.sessionId });
    const dto = await stack.executor.executeSecurityEvent(s.sessionId, { securityEvent: "suspected-compromise" });
    assert.equal(dto.currentGeneration, 1);
    const active = dto.generations.find((g) => g.status === "active");
    assert.equal(active.trigger, "security-event");
  });

  it("runDue evolves every session whose deferred evolution is due", async () => {
    const ids = [makeSessionId(1), makeSessionId(2), makeSessionId(3)];
    for (const sid of ids) {
      await start(stack.manager, { sessionId: sid, handshakeId: `hs-${sid}` });
      await stack.evolution.createEvolutionState({ sessionId: sid });
      await stack.evolution.schedule(sid, { dueInMs: 1000, reason: "scheduled rotate" });
    }
    assert.equal(stack.executor.evolution ? true : false, true);
    const before = await stack.executor.runDue(stack.evolution.scheduler);
    assert.equal(before.ran, 0, "not yet due");
    stack.clock.advance(1000);
    const after = await stack.executor.runDue(stack.evolution.scheduler);
    assert.equal(after.ran, 3);
    for (const sid of ids) assert.equal((await stack.manager.getStatus(sid)).currentGeneration, 1);
  });
});

describe("forward-secrecy event bus", () => {
  it("delivers to specific + wildcard handlers and unsubscribes", () => {
    const { events } = makeManager();
    const specific = [];
    const all = [];
    const off = events.on(ForwardSecrecyEventType.GENERATION_ADVANCED, (e) => specific.push(e));
    events.on("*", (e) => all.push(e));
    events.emit(ForwardSecrecyEventType.GENERATION_ADVANCED, { sessionId: "s", generation: 1 });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 1);
    assert.equal(typeof specific[0].at, "number");
    off();
    events.emit(ForwardSecrecyEventType.GENERATION_ADVANCED, { sessionId: "s", generation: 2 });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
  });
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RekeyExecutionEngine } from "../execution/executionEngine.js";
import { RekeyEventBus } from "../events/events.js";
import { RekeyEventType, ExecutionState } from "../types/types.js";

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  return clock;
}

/** Ops factory: a controllable evolve + generation source + no-op persist. */
function makeOps({ generation = 0, evolve } = {}) {
  const persisted = [];
  return {
    persisted,
    currentGeneration: async () => generation,
    evolve: evolve ?? (async () => ({ currentGeneration: generation + 1 })),
    persist: (execution) => {
      persisted.push({ ...execution });
    },
  };
}

describe("RekeyExecutionEngine", () => {
  let engine, events, seen;
  beforeEach(() => {
    events = new RekeyEventBus();
    seen = [];
    events.on("*", (e) => seen.push(e.type));
    engine = new RekeyExecutionEngine({ events, clock: makeClock(), maxAttempts: 2 });
  });

  it("runs pending → executing → completed", async () => {
    const ops = makeOps({ generation: 0 });
    const r = await engine.submit({ sessionId: "session-000001", trigger: "manual", expectedGeneration: 0 }, ops);
    assert.equal(r.executed, true);
    assert.equal(r.execution.state, ExecutionState.COMPLETED);
    assert.equal(r.generation, 1);
    assert.ok(seen.includes(RekeyEventType.REKEY_QUEUED));
    assert.ok(seen.includes(RekeyEventType.REKEY_STARTED));
    assert.ok(seen.includes(RekeyEventType.REKEY_COMPLETED));
    // persisted snapshots progressed through the states
    assert.deepEqual(
      ops.persisted.map((e) => e.state),
      [ExecutionState.PENDING, ExecutionState.EXECUTING, ExecutionState.COMPLETED],
    );
  });

  it("coalesces a stale trigger (expectedGeneration != current) without evolving", async () => {
    let evolveCalls = 0;
    const ops = makeOps({ generation: 5, evolve: async () => (evolveCalls++, { currentGeneration: 6 }) });
    const r = await engine.submit({ sessionId: "session-000001", trigger: "message-count", expectedGeneration: 3 }, ops);
    assert.equal(r.coalesced, true);
    assert.equal(r.executed, false);
    assert.equal(r.execution.state, ExecutionState.CANCELLED);
    assert.equal(evolveCalls, 0, "evolve NOT called for a coalesced/duplicate trigger");
    assert.ok(seen.includes(RekeyEventType.REKEY_CANCELLED));
  });

  it("retries a failing evolution then succeeds", async () => {
    let calls = 0;
    const ops = makeOps({
      generation: 0,
      evolve: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("boom"), { code: "ERR_FS_EVOLUTION_FAILED" });
        return { currentGeneration: 1 };
      },
    });
    const r = await engine.submit({ sessionId: "session-000001", trigger: "manual", expectedGeneration: 0 }, ops);
    assert.equal(r.executed, true);
    assert.equal(r.execution.attempts, 2);
    assert.ok(seen.includes(RekeyEventType.REKEY_RETRY));
  });

  it("fails after exhausting retries", async () => {
    const ops = makeOps({ generation: 0, evolve: async () => { throw Object.assign(new Error("nope"), { code: "ERR_FS_EVOLUTION_FAILED" }); } });
    const r = await engine.submit({ sessionId: "session-000001", trigger: "manual", expectedGeneration: 0 }, ops);
    assert.equal(r.executed, false);
    assert.equal(r.execution.state, ExecutionState.FAILED);
    assert.equal(r.execution.attempts, 2);
    assert.ok(seen.includes(RekeyEventType.REKEY_FAILED));
  });

  it("serializes concurrent submits for the same session (no overlapping evolve)", async () => {
    let running = 0;
    let maxConcurrent = 0;
    let gen = 0;
    const ops = {
      persisted: [],
      currentGeneration: async () => gen,
      persist: () => {},
      evolve: async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setImmediate(r));
        running--;
        gen += 1;
        return { currentGeneration: gen };
      },
    };
    // fire three concurrently; each observes the generation at fire time (all 0 here, but
    // the engine re-reads inside the lock so only the first proceeds, others coalesce).
    const results = await Promise.all([
      engine.submit({ sessionId: "session-000001", trigger: "manual" }, ops),
      engine.submit({ sessionId: "session-000001", trigger: "manual" }, ops),
      engine.submit({ sessionId: "session-000001", trigger: "manual" }, ops),
    ]);
    assert.equal(maxConcurrent, 1, "at most one evolve ran at a time");
    // with no expectedGeneration, all three run (serialized) → 3 evolutions
    assert.equal(results.filter((r) => r.executed).length, 3);
    assert.equal(gen, 3);
  });

  it("deduplicates a burst of same-generation triggers to a single rekey", async () => {
    let gen = 0;
    const ops = {
      persisted: [],
      currentGeneration: async () => gen,
      persist: () => {},
      evolve: async () => {
        await new Promise((r) => setImmediate(r));
        gen += 1;
        return { currentGeneration: gen };
      },
    };
    // all three fired "at generation 0"; the first advances to 1, the rest coalesce.
    const results = await Promise.all([0, 0, 0].map(() => engine.submit({ sessionId: "session-000001", trigger: "message-count", expectedGeneration: 0 }, ops)));
    assert.equal(results.filter((r) => r.executed).length, 1, "exactly one rekey");
    assert.equal(results.filter((r) => r.coalesced).length, 2, "two coalesced");
    assert.equal(gen, 1);
  });
});

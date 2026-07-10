import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionEventBus } from "../../shs/session/events/events.js";
import { attachSessionEvolution, deriveGenerationView } from "../integration/sessionEvolutionBridge.js";
import { EvolutionState } from "../types/types.js";
import { makeManager, makeSessionId } from "./helpers.js";

/** Wait for the bridge's async (microtask) handlers to settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe("application integration — session ↔ evolution bridge", () => {
  it("mirrors session.created → an evolution record at generation 0", async () => {
    const { manager } = makeManager();
    const sessionEvents = new SessionEventBus();
    const detach = attachSessionEvolution({ sessionEvents, evolutionManager: manager, onError: () => {} });

    sessionEvents.emit("session.created", { sessionId: makeSessionId(1), handshakeId: "hs-1" });
    await flush();
    const rec = await manager.findEvolutionState(makeSessionId(1));
    assert.ok(rec, "evolution record created");
    assert.equal(rec.state, EvolutionState.STABLE);
    assert.equal(rec.generation, 0);
    detach();
  });

  it("mirrors session.rekeyed → generation advance (metadata only)", async () => {
    const { manager } = makeManager();
    const sessionEvents = new SessionEventBus();
    attachSessionEvolution({ sessionEvents, evolutionManager: manager, onError: () => {} });

    const sid = makeSessionId(2);
    sessionEvents.emit("session.created", { sessionId: sid, handshakeId: "hs-2" });
    await flush();
    sessionEvents.emit("session.rekeyed", { sessionId: sid, generation: 1 });
    await flush();
    const rec = await manager.findEvolutionState(sid);
    assert.equal(rec.generation, 1);
    assert.equal(rec.versionHistory[0].trigger, "session-rekey");
  });

  it("mirrors session close/destroy → retirement; duplicate created is ignored", async () => {
    const { manager } = makeManager();
    const sessionEvents = new SessionEventBus();
    attachSessionEvolution({ sessionEvents, evolutionManager: manager, onError: () => {} });

    const sid = makeSessionId(3);
    sessionEvents.emit("session.created", { sessionId: sid, handshakeId: "hs-3" });
    await flush();
    // a duplicate created event must NOT throw or create a second record
    sessionEvents.emit("session.created", { sessionId: sid, handshakeId: "hs-3" });
    await flush();
    sessionEvents.emit("session.destroyed", { sessionId: sid });
    await flush();
    const rec = await manager.findEvolutionState(sid);
    assert.equal(rec.state, EvolutionState.RETIRED);
  });

  it("bridge swallows errors (never breaks the session flow)", async () => {
    const errors = [];
    // A manager whose repo.findBySessionId throws — the guard must catch it.
    const brokenManager = {
      async findEvolutionState() {
        throw new Error("boom");
      },
    };
    const sessionEvents = new SessionEventBus();
    attachSessionEvolution({ sessionEvents, evolutionManager: brokenManager, onError: (_s, e) => errors.push(e) });
    assert.doesNotThrow(() => sessionEvents.emit("session.created", { sessionId: makeSessionId(4) }));
    await flush();
    assert.equal(errors.length, 1);
  });

  it("deriveGenerationView fuses session + evolution into a client view", () => {
    const view = deriveGenerationView(
      { sessionId: "session-000001", status: "active" },
      { sessionId: "session-000001", generation: 2, state: "stable", keyVersion: { current: 2 }, isPending: false, policies: [{ id: "p1", type: "manual" }], securityMetadata: { forwardSecrecy: false, ratcheting: false } },
    );
    assert.equal(view.generation, 2);
    assert.equal(view.status, "active");
    assert.equal(view.security.forwardSecrecy, false);
    assert.equal(view.policies[0].type, "manual");
  });
});

describe("scale + concurrency", () => {
  it("tracks many concurrent evolution records with distinct ids", async () => {
    const { manager } = makeManager();
    const N = 100;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => manager.createEvolutionState({ sessionId: makeSessionId(i), handshakeId: `hs-${i}` })),
    );
    assert.equal(new Set(created.map((r) => r.sessionId)).size, N);
    assert.equal(new Set(created.map((r) => r.evolutionId)).size, N);
    assert.equal((await manager.listByState(EvolutionState.STABLE)).length, N);
  });

  it("stress: 50 advance cycles keep a monotonic, gap-free timeline", async () => {
    const { manager } = makeManager();
    const sid = makeSessionId(1);
    await manager.createEvolutionState({ sessionId: sid });
    for (let i = 0; i < 50; i++) await manager.advanceGeneration(sid, { reason: `cycle-${i}` });
    const rec = await manager.getEvolutionState(sid);
    assert.equal(rec.generation, 50);
    assert.equal(rec.versionHistory.length, 50);
    const gens = rec.versionHistory.map((h) => h.generation);
    assert.deepEqual(gens, Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("many sessions each schedule + advance independently", async () => {
    const { manager, scheduler } = makeManager();
    const ids = Array.from({ length: 10 }, (_, i) => makeSessionId(i));
    await Promise.all(ids.map((sid) => manager.createEvolutionState({ sessionId: sid })));
    await Promise.all(ids.map((sid) => manager.schedule(sid, { dueInMs: 1000 })));
    assert.equal(scheduler.size, 10);
    await Promise.all(ids.map((sid) => manager.advanceGeneration(sid)));
    // advancing clears each pending plan
    assert.equal(scheduler.size, 0);
    for (const sid of ids) assert.equal((await manager.getStatus(sid)).generation, 1);
  });
});

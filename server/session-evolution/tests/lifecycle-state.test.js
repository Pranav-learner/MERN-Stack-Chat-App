import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvolutionState,
  ALL_EVOLUTION_STATES,
  isTerminalEvolutionState,
  isActiveEvolutionState,
  isPendingEvolutionState,
} from "../types/types.js";
import {
  EvolutionLifecycle,
  ALLOWED_EVOLUTION_TRANSITIONS,
  canEvolutionTransition,
  assertEvolutionTransition,
  nextEvolutionStates,
} from "../lifecycle/lifecycle.js";
import { InvalidEvolutionTransitionError } from "../errors.js";
import { createEvolutionRecord, projectNextGeneration } from "../state/evolutionState.js";
import { makeClock, makeIdGen } from "./helpers.js";

describe("evolution lifecycle — state machine", () => {
  it("every state is reachable and terminal RETIRED has no exits", () => {
    for (const s of ALL_EVOLUTION_STATES) {
      assert.ok(Array.isArray(ALLOWED_EVOLUTION_TRANSITIONS[s]), `missing transitions for ${s}`);
    }
    assert.deepEqual(ALLOWED_EVOLUTION_TRANSITIONS[EvolutionState.RETIRED], []);
    assert.ok(isTerminalEvolutionState(EvolutionState.RETIRED));
    assert.ok(!isTerminalEvolutionState(EvolutionState.STABLE));
  });

  it("classifies active + pending states", () => {
    assert.ok(isActiveEvolutionState(EvolutionState.STABLE));
    assert.ok(!isActiveEvolutionState(EvolutionState.RETIRED));
    assert.ok(isPendingEvolutionState(EvolutionState.SCHEDULED));
    assert.ok(isPendingEvolutionState(EvolutionState.PENDING));
    assert.ok(!isPendingEvolutionState(EvolutionState.STABLE));
  });

  it("canEvolutionTransition guards legal + illegal moves", () => {
    assert.ok(canEvolutionTransition(EvolutionState.INITIALIZED, EvolutionState.STABLE));
    assert.ok(canEvolutionTransition(EvolutionState.STABLE, EvolutionState.EVOLVING));
    assert.ok(canEvolutionTransition(EvolutionState.EVOLVING, EvolutionState.EVOLVED));
    assert.ok(!canEvolutionTransition(EvolutionState.INITIALIZED, EvolutionState.EVOLVED));
    assert.ok(!canEvolutionTransition(EvolutionState.RETIRED, EvolutionState.STABLE));
  });

  it("assertEvolutionTransition throws on an illegal move", () => {
    assert.throws(() => assertEvolutionTransition(EvolutionState.RETIRED, EvolutionState.STABLE), InvalidEvolutionTransitionError);
    assert.doesNotThrow(() => assertEvolutionTransition(EvolutionState.STABLE, EvolutionState.PENDING));
  });

  it("nextEvolutionStates returns a copy", () => {
    const a = nextEvolutionStates(EvolutionState.STABLE);
    a.push("mutated");
    assert.ok(!nextEvolutionStates(EvolutionState.STABLE).includes("mutated"));
  });

  it("EvolutionLifecycle drives a full advance path with history", () => {
    const clock = makeClock();
    const fsm = new EvolutionLifecycle(EvolutionState.INITIALIZED, { clock });
    fsm.transition(EvolutionState.STABLE);
    fsm.transition(EvolutionState.EVOLVING, { reason: "policy" });
    fsm.transition(EvolutionState.EVOLVED);
    fsm.transition(EvolutionState.STABLE);
    assert.equal(fsm.state, EvolutionState.STABLE);
    assert.equal(fsm.history.length, 4);
    assert.equal(fsm.history[1].reason, "policy");
  });

  it("EvolutionLifecycle rejects unknown initial state + illegal transition", () => {
    assert.throws(() => new EvolutionLifecycle("nonsense"), InvalidEvolutionTransitionError);
    const fsm = new EvolutionLifecycle(EvolutionState.INITIALIZED);
    assert.throws(() => fsm.transition(EvolutionState.EVOLVED), InvalidEvolutionTransitionError);
  });
});

describe("evolution state model — factory", () => {
  const deps = { clock: makeClock(), idGenerator: makeIdGen() };

  it("creates an INITIALIZED record with generation 0 and inert future placeholders", () => {
    const rec = createEvolutionRecord({ sessionId: "session-000001", handshakeId: "hs-1", ...deps });
    assert.equal(rec.state, EvolutionState.INITIALIZED);
    assert.equal(rec.generation, 0);
    assert.deepEqual(rec.keyVersion, { current: 0, previous: null, next: null });
    assert.equal(rec.versionHistory.length, 0);
    assert.equal(rec.pending, null);
    // security metadata advertises NO crypto is active
    assert.equal(rec.securityMetadata.forwardSecrecy, false);
    assert.equal(rec.securityMetadata.ratcheting, false);
    assert.equal(rec.securityMetadata.keyRotationPerformed, false);
    // future placeholders are inert + reserved
    assert.equal(rec.ratchetMetadata.reserved, true);
    assert.equal(rec.chainMetadata.reserved, true);
    assert.equal(rec.messageMetadata.reserved, true);
    // never carries key material
    assert.equal(JSON.stringify(rec).includes("sharedSecret"), false);
    assert.equal(JSON.stringify(rec).toLowerCase().includes("bytes"), false);
  });

  it("projectNextGeneration rolls pointers without mutating", () => {
    const rec = createEvolutionRecord({ sessionId: "session-000001", ...deps });
    const next = projectNextGeneration(rec);
    assert.equal(next.generation, 1);
    assert.deepEqual(next.keyVersion, { current: 1, previous: 0, next: null });
    assert.equal(rec.generation, 0, "original record untouched");
  });
});

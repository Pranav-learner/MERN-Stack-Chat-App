import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EvolutionEventBus } from "../events/events.js";
import { EvolutionEventType } from "../types/types.js";
import {
  createEvolutionMetadata,
  createPolicyMetadata,
  createSecurityMetadata,
  createAuditEntry,
  appendAudit,
  createRatchetMetadata,
  createChainMetadata,
  createMessageMetadata,
  recomputeMetadata,
} from "../metadata/metadata.js";
import { createTimeBasedPolicy, createManualPolicy } from "../policies/policies.js";

describe("evolution event bus", () => {
  it("delivers to specific handlers + wildcard, and unsubscribes", () => {
    const bus = new EvolutionEventBus();
    const specific = [];
    const wildcard = [];
    const off = bus.on(EvolutionEventType.CREATED, (e) => specific.push(e));
    bus.on("*", (e) => wildcard.push(e));
    bus.emit(EvolutionEventType.CREATED, { evolutionId: "evo-1", sessionId: "session-000001" });
    assert.equal(specific.length, 1);
    assert.equal(wildcard.length, 1);
    assert.equal(specific[0].type, EvolutionEventType.CREATED);
    assert.equal(typeof specific[0].at, "number");
    off();
    bus.emit(EvolutionEventType.CREATED, { evolutionId: "evo-2", sessionId: "session-000002" });
    assert.equal(specific.length, 1, "unsubscribed");
    assert.equal(wildcard.length, 2);
  });

  it("once fires a single time", () => {
    const bus = new EvolutionEventBus();
    let count = 0;
    bus.once(EvolutionEventType.RETIRED, () => count++);
    bus.emit(EvolutionEventType.RETIRED, { evolutionId: "e", sessionId: "s" });
    bus.emit(EvolutionEventType.RETIRED, { evolutionId: "e", sessionId: "s" });
    assert.equal(count, 1);
  });
});

describe("metadata framework", () => {
  it("evolution + policy + security blocks", () => {
    const evo = createEvolutionMetadata({ generation: 2, evolutionCount: 2 });
    assert.equal(evo.generation, 2);
    assert.equal(evo.evolutionCount, 2);
    const pol = createPolicyMetadata([createTimeBasedPolicy({ intervalMs: 1 }), createManualPolicy({ enabled: false })], { at: "t" });
    assert.equal(pol.count, 2);
    assert.equal(pol.enabled, 1);
    assert.deepEqual(pol.types.sort(), ["manual", "time-based"]);
    const sec = createSecurityMetadata();
    assert.equal(sec.forwardSecrecy, false);
    assert.equal(sec.ratcheting, false);
    assert.equal(sec.postCompromiseSecurity, false);
    assert.equal(sec.keyRotationPerformed, false);
  });

  it("future placeholders are inert + carry no key material", () => {
    for (const block of [createRatchetMetadata(), createChainMetadata(), createMessageMetadata()]) {
      assert.equal(block.enabled, false);
      assert.equal(block.reserved, true);
      assert.equal("bytes" in block, false);
      assert.equal("secret" in block, false);
      assert.equal("key" in block, false);
    }
  });

  it("audit append is immutable + capped", () => {
    const entry = createAuditEntry("created", { generation: 0, trigger: "system" });
    assert.equal(entry.action, "created");
    assert.equal(entry.generation, 0);
    const a1 = appendAudit([], entry);
    const a2 = appendAudit(a1, createAuditEntry("advanced"));
    assert.equal(a1.length, 1, "original not mutated");
    assert.equal(a2.length, 2);
    // cap
    let big = [];
    for (let i = 0; i < 250; i++) big = appendAudit(big, createAuditEntry(`a${i}`), 200);
    assert.equal(big.length, 200);
  });

  it("recomputeMetadata reflects live record fields", () => {
    const rec = {
      generation: 3,
      keyVersion: { current: 3, previous: 2, next: null },
      versionHistory: [{ generation: 1 }, { generation: 2 }, { generation: 3 }],
      lastEvolutionAt: "t3",
      policies: [createManualPolicy()],
      policyMetadata: {},
    };
    const { evolutionMetadata, policyMetadata } = recomputeMetadata(rec, { at: "now" });
    assert.equal(evolutionMetadata.generation, 3);
    assert.equal(evolutionMetadata.evolutionCount, 3);
    assert.equal(evolutionMetadata.lastEvolutionAt, "t3");
    assert.equal(policyMetadata.count, 1);
    assert.equal(policyMetadata.lastPolicyUpdate, "now");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GenerationStatus,
  canGenerationTransition,
  assertGenerationTransition,
  assertForwardOnly,
  ALLOWED_GENERATION_TRANSITIONS,
} from "../lifecycle/generationLifecycle.js";
import {
  validateSessionRef,
  requireState,
  validateEvolutionRequest,
  assertGenerationOrdering,
  assertSessionOwnership,
  assertSessionState,
  assertVersionConsistency,
  assertNotDestroyed,
  assertNoReplay,
  validateRepository,
} from "../validation/validators.js";
import {
  ForwardSecrecyValidationError,
  GenerationNotFoundError,
  GenerationOrderingError,
  RollbackDetectedError,
  ReplayDetectedError,
  DestroyedKeyReferenceError,
  SessionOwnershipError,
  ForwardSecrecyStateError,
} from "../errors.js";
import { createInMemoryForwardSecrecyRepository } from "../repository/inMemoryForwardSecrecyRepository.js";

describe("generation lifecycle", () => {
  it("legal transitions only; DESTROYED terminal", () => {
    assert.ok(canGenerationTransition(GenerationStatus.PENDING, GenerationStatus.ACTIVE));
    assert.ok(canGenerationTransition(GenerationStatus.ACTIVE, GenerationStatus.SUPERSEDED));
    assert.ok(canGenerationTransition(GenerationStatus.SUPERSEDED, GenerationStatus.DESTROYED));
    assert.ok(!canGenerationTransition(GenerationStatus.DESTROYED, GenerationStatus.ACTIVE));
    assert.deepEqual(ALLOWED_GENERATION_TRANSITIONS[GenerationStatus.DESTROYED], []);
    assert.throws(() => assertGenerationTransition(GenerationStatus.DESTROYED, GenerationStatus.ACTIVE), GenerationOrderingError);
  });

  it("assertForwardOnly enforces +1 and blocks rollback/replay", () => {
    assert.doesNotThrow(() => assertForwardOnly(0, 1));
    assert.throws(() => assertForwardOnly(2, 2), RollbackDetectedError, "equal is a rollback");
    assert.throws(() => assertForwardOnly(2, 1), RollbackDetectedError, "lower is a rollback");
    assert.throws(() => assertForwardOnly(0, 2), GenerationOrderingError, "gap is illegal");
  });
});

describe("forward-secrecy validators", () => {
  it("session ref + require", () => {
    assert.equal(validateSessionRef("session-000001"), "session-000001");
    assert.throws(() => validateSessionRef("bad"), ForwardSecrecyValidationError);
    assert.throws(() => requireState(null, "x"), GenerationNotFoundError);
  });

  it("evolution request rejects malformed payloads + key material", () => {
    assert.doesNotThrow(() => validateEvolutionRequest({ sessionId: "session-000001" }));
    assert.throws(() => validateEvolutionRequest(null), ForwardSecrecyValidationError);
    assert.throws(() => validateEvolutionRequest({ sessionId: "session-000001", reason: 5 }), ForwardSecrecyValidationError);
    for (const forbidden of ["chainSecret", "keys", "encryptionKey", "sharedSecret", "rootSecret"]) {
      assert.throws(() => validateEvolutionRequest({ sessionId: "session-000001", [forbidden]: "x" }), ForwardSecrecyValidationError);
    }
  });

  it("ordering, ownership, state, consistency, destroyed-ref, replay", () => {
    assert.doesNotThrow(() => assertGenerationOrdering(1, 2));
    assert.throws(() => assertGenerationOrdering(2, 1), RollbackDetectedError);

    assert.doesNotThrow(() => assertSessionOwnership(["alice", "bob"], "alice"));
    assert.doesNotThrow(() => assertSessionOwnership(["alice"], undefined), "ownership is opt-in");
    assert.throws(() => assertSessionOwnership(["alice"], "carol"), SessionOwnershipError);

    assert.doesNotThrow(() => assertSessionState("active"));
    assert.doesNotThrow(() => assertSessionState(undefined));
    assert.throws(() => assertSessionState("closed"), ForwardSecrecyStateError);

    assert.doesNotThrow(() => assertVersionConsistency(2, 2));
    assert.throws(() => assertVersionConsistency(2, 1), ForwardSecrecyStateError);

    assert.doesNotThrow(() => assertNotDestroyed({ keyId: "k" }, 1));
    assert.throws(() => assertNotDestroyed(null, 1), DestroyedKeyReferenceError);

    assert.doesNotThrow(() => assertNoReplay([{ generation: 1 }], 2));
    assert.throws(() => assertNoReplay([{ generation: 2 }], 2), ReplayDetectedError);
  });

  it("repository contract validation", () => {
    assert.throws(() => validateRepository({}), ForwardSecrecyValidationError);
    assert.doesNotThrow(() => validateRepository(createInMemoryForwardSecrecyRepository().forwardSecrecy));
  });
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryEvolutionRepository } from "../repository/inMemoryEvolutionRepository.js";
import { createEvolutionRecord } from "../state/evolutionState.js";
import {
  validateEvolutionId,
  validateSessionRef,
  requireEvolution,
  assertNoDuplicateEvolution,
  assertNotRetired,
  validateGeneration,
  validateEvolutionMetadata,
  validatePolicyDescriptor,
  assertNoPolicyConflict,
  validateEvolutionRequest,
  validateRepository,
} from "../validators/validators.js";
import {
  toPublicEvolution,
  toEvolutionStatus,
  toEvolutionMetadata,
} from "../serialization/serializer.js";
import {
  isValidGeneration,
  assertMonotonicAdvance,
  assertNoDuplicateGeneration,
  buildVersionEntry,
} from "../evolution/generations.js";
import {
  EvolutionValidationError,
  EvolutionNotFoundError,
  DuplicateEvolutionError,
  CorruptedEvolutionMetadataError,
  PolicyConflictError,
  EvolutionRetiredError,
  InvalidGenerationError,
  DuplicateGenerationError,
} from "../errors.js";
import { createManualPolicy, createTimeBasedPolicy } from "../policies/policies.js";
import { EvolutionState } from "../types/types.js";
import { makeClock, makeIdGen } from "./helpers.js";

const deps = () => ({ clock: makeClock(), idGenerator: makeIdGen() });
const record = (over = {}) => createEvolutionRecord({ sessionId: "session-000001", ...deps(), ...over });

describe("evolution repository — in-memory contract", () => {
  let repo, reset;
  beforeEach(() => {
    ({ evolutions: repo, reset } = createInMemoryEvolutionRepository());
  });

  it("create/find/update/delete round-trips + deep-copies", async () => {
    const rec = record();
    await repo.create(rec);
    const byS = await repo.findBySessionId(rec.sessionId);
    assert.equal(byS.evolutionId, rec.evolutionId);
    byS.generation = 999; // mutate the returned copy
    assert.equal((await repo.findBySessionId(rec.sessionId)).generation, 0, "store not mutated");

    const byId = await repo.findById(rec.evolutionId);
    assert.equal(byId.sessionId, rec.sessionId);

    await repo.update(rec.sessionId, { generation: 2, state: EvolutionState.STABLE });
    assert.equal((await repo.findBySessionId(rec.sessionId)).generation, 2);

    assert.equal(await repo.delete(rec.sessionId), true);
    assert.equal(await repo.findBySessionId(rec.sessionId), null);
  });

  it("update on a missing session throws; findByState + listAll filter", async () => {
    await assert.rejects(() => repo.update("session-000009", {}), EvolutionNotFoundError);
    await repo.create(record({ sessionId: "session-000001" }));
    await repo.create(record({ sessionId: "session-000002" }));
    await repo.update("session-000002", { state: EvolutionState.RETIRED });
    assert.equal((await repo.findByState(EvolutionState.INITIALIZED)).length, 1);
    assert.equal((await repo.listAll()).length, 2);
    reset();
    assert.equal((await repo.listAll()).length, 0);
  });
});

describe("evolution validators", () => {
  it("id + session-ref shape", () => {
    assert.equal(validateEvolutionId("evolution-1"), "evolution-1");
    assert.throws(() => validateEvolutionId("short"), EvolutionValidationError);
    assert.equal(validateSessionRef("session-000001"), "session-000001");
    assert.throws(() => validateSessionRef(123), EvolutionValidationError);
  });

  it("require + duplicate + retired guards", () => {
    assert.throws(() => requireEvolution(null, "x"), EvolutionNotFoundError);
    assert.throws(() => assertNoDuplicateEvolution(record()), DuplicateEvolutionError);
    assert.doesNotThrow(() => assertNoDuplicateEvolution(null));
    assert.throws(() => assertNotRetired({ state: EvolutionState.RETIRED }), EvolutionRetiredError);
  });

  it("generation validation", () => {
    assert.equal(validateGeneration(3), 3);
    assert.throws(() => validateGeneration(-1), EvolutionValidationError);
    assert.ok(isValidGeneration(0));
    assert.ok(!isValidGeneration(1.5));
    assert.throws(() => assertMonotonicAdvance(1, 3), InvalidGenerationError);
    assert.doesNotThrow(() => assertMonotonicAdvance(1, 2));
    assert.throws(() => assertNoDuplicateGeneration([{ generation: 2 }], 2), DuplicateGenerationError);
  });

  it("metadata corruption detection + no-key-material invariant", () => {
    assert.doesNotThrow(() => validateEvolutionMetadata(record()));
    assert.throws(() => validateEvolutionMetadata({}), CorruptedEvolutionMetadataError);
    assert.throws(() => validateEvolutionMetadata({ ...record(), state: "bogus" }), CorruptedEvolutionMetadataError);
    assert.throws(() => validateEvolutionMetadata({ ...record(), sharedSecret: "x" }), CorruptedEvolutionMetadataError);
    const dupHistory = { ...record(), versionHistory: [{ generation: 1 }, { generation: 1 }] };
    assert.throws(() => validateEvolutionMetadata(dupHistory), CorruptedEvolutionMetadataError);
  });

  it("policy descriptor + conflict validation", () => {
    assert.doesNotThrow(() => validatePolicyDescriptor(createManualPolicy()));
    assert.throws(() => validatePolicyDescriptor({ id: "x", type: "unknown" }), EvolutionValidationError);
    const manual = createManualPolicy();
    assert.throws(() => assertNoPolicyConflict([manual], manual), PolicyConflictError);
    assert.throws(() => assertNoPolicyConflict([manual], createManualPolicy()), PolicyConflictError);
    assert.doesNotThrow(() => assertNoPolicyConflict([createTimeBasedPolicy({ intervalMs: 1 })], createTimeBasedPolicy({ intervalMs: 2 })));
  });

  it("evolution request + repository validation", () => {
    assert.doesNotThrow(() => validateEvolutionRequest({ sessionId: "session-000001" }));
    assert.throws(() => validateEvolutionRequest(null), EvolutionValidationError);
    assert.throws(() => validateEvolutionRequest({ sessionId: "session-000001", reason: 5 }), EvolutionValidationError);
    assert.throws(() => validateEvolutionRequest({ sessionId: "session-000001", policies: "no" }), EvolutionValidationError);
    assert.throws(() => validateRepository({}), EvolutionValidationError);
    assert.doesNotThrow(() => validateRepository(createInMemoryEvolutionRepository().evolutions));
  });
});

describe("evolution serializer", () => {
  it("public DTO whitelists fields + flags active/pending/retired", () => {
    const rec = { ...record(), state: EvolutionState.PENDING, versionHistory: [buildVersionEntry({ generation: 1, keyVersion: 1, at: "t" })] };
    const dto = toPublicEvolution(rec);
    assert.equal(dto.state, EvolutionState.PENDING);
    assert.equal(dto.isPending, true);
    assert.equal(dto.isActive, true);
    assert.equal(dto.isRetired, false);
    assert.equal(dto.versionHistory.length, 1);
    assert.equal("audit" in dto, false, "audit hidden by default");
    assert.equal("audit" in toPublicEvolution(rec, { includeAudit: true }), true);
  });

  it("status + metadata bundle views", () => {
    const rec = record();
    const status = toEvolutionStatus(rec);
    assert.equal(status.generation, 0);
    assert.equal(status.isRetired, false);
    const meta = toEvolutionMetadata(rec);
    assert.equal(meta.security.forwardSecrecy, false);
    assert.equal(meta.ratchet.reserved, true);
    assert.equal(meta.chain.reserved, true);
    assert.equal(meta.message.reserved, true);
  });
});

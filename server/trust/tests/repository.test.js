import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryTrustRepositories } from "../repository/inMemoryRepository.js";
import { VerificationNotFoundError } from "../errors.js";

describe("in-memory trust repositories", () => {
  let repos;
  beforeEach(() => {
    repos = createInMemoryTrustRepositories();
  });

  const record = (verifier, subject) => ({
    verificationId: `v-${verifier}-${subject}`,
    verifierUser: verifier,
    subjectUser: subject,
    subjectIdentityId: `id-${subject}`,
    verifiedPublicKey: "pk",
    verifiedFingerprint: "fp",
    safetyNumber: "1".repeat(60),
    trustState: "verified",
    method: "manual",
    history: [],
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });

  it("create/findByPair/findById/update/delete", async () => {
    await repos.verifications.create(record("alice", "bob"));
    assert.equal((await repos.verifications.findByPair("alice", "bob")).subjectUser, "bob");
    assert.equal((await repos.verifications.findById("v-alice-bob")).verifierUser, "alice");
    assert.equal((await repos.verifications.update("v-alice-bob", { trustState: "trusted" })).trustState, "trusted");
    assert.equal(await repos.verifications.delete("v-alice-bob"), true);
    assert.equal(await repos.verifications.findByPair("alice", "bob"), null);
  });

  it("findByVerifier / findBySubject", async () => {
    await repos.verifications.create(record("alice", "bob"));
    await repos.verifications.create(record("alice", "carol"));
    await repos.verifications.create(record("dave", "bob"));
    assert.equal((await repos.verifications.findByVerifier("alice")).length, 2);
    assert.equal((await repos.verifications.findBySubject("bob")).length, 2);
  });

  it("update on missing throws", async () => {
    await assert.rejects(() => repos.verifications.update("nope", {}), VerificationNotFoundError);
  });

  it("change log create/findBySubject and record isolation", async () => {
    const r = record("alice", "bob");
    await repos.verifications.create(r);
    r.trustState = "mutated";
    assert.notEqual((await repos.verifications.findById("v-alice-bob")).trustState, "mutated");

    await repos.changes.create({ subjectUser: "bob", fromFingerprint: "a", toFingerprint: "b", detectedAt: "t" });
    assert.equal((await repos.changes.findBySubject("bob")).length, 1);
    assert.equal((await repos.changes.findBySubject("carol")).length, 0);
  });
});

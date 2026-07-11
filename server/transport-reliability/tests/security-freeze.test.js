/**
 * Security validation + protocol freeze + validators (Layer 8, Sprint 3). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  auditDataPlaneApis,
  API_SECURITY_POSTURE,
  SECURITY_ASSUMPTIONS,
  assertParticipant,
  normalizePagination,
  makeRateLimitGate,
  auditOperation,
} from "../security/securityAudit.js";
import { protocolManifest, isDataPlaneCompatible, EXTENSION_POINTS, DOES_NOT_IMPLEMENT, FROZEN_INTERFACES } from "../freeze/protocolFreeze.js";
import { assertNoPlaintext, validateRegisterRequest, validateRepository, FORBIDDEN_KEYS } from "../validators/validators.js";

describe("security audit", () => {
  it("passes the posture audit for all Data Plane API groups", () => {
    const audit = auditDataPlaneApis();
    assert.equal(audit.ok, true);
    assert.equal(audit.findings.length, 0);
    assert.ok(audit.groups >= 3);
    assert.ok(SECURITY_ASSUMPTIONS.length >= 5);
  });

  it("flags a group missing a required control", () => {
    const bad = { ...API_SECURITY_POSTURE, "x": { authenticated: true, ownerScoped: false, opaqueCiphertextOnly: true, integrityChecked: true } };
    const audit = auditDataPlaneApis(bad);
    assert.equal(audit.ok, false);
    assert.ok(audit.findings.some((f) => f.missing === "ownerScoped"));
  });

  it("assertParticipant guards sender + receiver", () => {
    const rec = { transferId: "t", senderDeviceId: "a", receiverDeviceId: "b" };
    assert.ok(assertParticipant(rec, "a"));
    assert.ok(assertParticipant(rec, "b"));
    assert.throws(() => assertParticipant(rec, "c"), /not a participant/);
  });

  it("normalizePagination clamps + defaults", () => {
    assert.deepEqual(normalizePagination({ limit: "5000", offset: "-1" }), { limit: 200, offset: 0 });
    assert.deepEqual(normalizePagination({}), { limit: 50, offset: 0 });
  });

  it("rate-limit extension point defaults to allow + fails open", () => {
    assert.deepEqual(makeRateLimitGate()("k"), { allowed: true });
    assert.deepEqual(makeRateLimitGate({ limiter: () => ({ allowed: false, remaining: 0 }) })("k"), { allowed: false, remaining: 0 });
    assert.deepEqual(makeRateLimitGate({ limiter: () => { throw new Error("boom"); } })("k"), { allowed: true });
  });

  it("auditOperation shapes an entry without payload/keys", () => {
    const e = auditOperation({ operation: "relay", transferId: "t", actingDevice: "a", outcome: "ok" });
    assert.equal(e.operation, "relay");
    assert.equal(e.data, undefined);
  });
});

describe("protocol freeze", () => {
  it("declares a frozen Data Plane manifest across all three sprints", () => {
    assert.equal(protocolManifest.frozen, true);
    assert.ok(FROZEN_INTERFACES["data-plane"]);
    assert.ok(FROZEN_INTERFACES["transport-engine"]);
    assert.ok(FROZEN_INTERFACES["transport-reliability"]);
  });

  it("documents Layer 9 extension points + explicit non-goals", () => {
    assert.ok(EXTENSION_POINTS.length >= 4);
    assert.ok(EXTENSION_POINTS.some((e) => /resume|checkpoint/i.test(e.seam)));
    assert.ok(DOES_NOT_IMPLEMENT.includes("offline-synchronization"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("group-messaging"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("voice-calls"));
  });

  it("checks Data Plane version compatibility by major", () => {
    assert.equal(isDataPlaneCompatible("1.4"), true);
    assert.equal(isDataPlaneCompatible("2.0"), false);
    assert.equal(isDataPlaneCompatible(null), false);
  });
});

describe("validators", () => {
  it("every forbidden key (incl. payload/data) is rejected", () => {
    for (const key of FORBIDDEN_KEYS) {
      assert.throws(() => assertNoPlaintext({ nested: { [key]: "x" } }), new RegExp(key), `should reject "${key}"`);
    }
  });

  it("cycle-safe deep scan", () => {
    const a = { ok: 1 };
    a.self = a;
    assert.doesNotThrow(() => assertNoPlaintext(a));
  });

  it("validateRegisterRequest enforces required fields", () => {
    assert.throws(() => validateRegisterRequest({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", totalChunks: 1 }), /transfer identifier/);
    assert.throws(() => validateRegisterRequest({ transferId: "t", conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", totalChunks: 0 }), /totalChunks/);
    assert.ok(validateRegisterRequest({ transferId: "t", conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", totalChunks: 3 }));
  });

  it("validateRepository checks the store contract", () => {
    assert.throws(() => validateRepository({ records: { create() {} } }), /missing method/);
  });
});

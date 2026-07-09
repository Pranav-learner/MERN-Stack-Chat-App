import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TrustManager } from "../manager/trustManager.js";
import { createInMemoryTrustRepositories } from "../repository/inMemoryRepository.js";
import { TrustEventBus } from "../events/trustEvents.js";
import { TrustState, TrustEventType, TrustWarningType } from "../types.js";
import {
  SafetyNumberMismatchError,
  FingerprintMismatchError,
  UnknownIdentityError,
  TrustValidationError,
  VerificationNotFoundError,
  InvalidTrustTransitionError,
} from "../errors.js";
import { makeIdentityStore, FAST_SN } from "./helpers.js";

describe("TrustManager", () => {
  let store;
  let repos;
  let events;
  let manager;

  beforeEach(() => {
    store = makeIdentityStore();
    repos = createInMemoryTrustRepositories();
    events = new TrustEventBus();
    manager = new TrustManager({
      ...repos,
      identityLookup: store.lookup,
      events,
      safetyNumberOptions: FAST_SN,
    });
    store.add("alice");
    store.add("bob");
    store.add("carol");
  });

  it("returns a fingerprint; unknown user throws", async () => {
    assert.match((await manager.getFingerprint("alice")).machine, /^[0-9a-f]{64}$/);
    await assert.rejects(() => manager.getFingerprint("ghost"), UnknownIdentityError);
  });

  it("safety number is symmetric and emits an event", async () => {
    let emitted = 0;
    events.on(TrustEventType.SAFETY_NUMBER_GENERATED, () => emitted++);
    const ab = await manager.getSafetyNumber("alice", "bob");
    const ba = await manager.getSafetyNumber("bob", "alice");
    assert.equal(ab.safetyNumber, ba.safetyNumber);
    assert.match(ab.safetyNumber, /^\d{60}$/);
    assert.equal(emitted, 2);
  });

  it("verifies an identity and records the safety number + fingerprint", async () => {
    let verified = 0;
    events.on(TrustEventType.IDENTITY_VERIFIED, () => verified++);
    const v = await manager.verifyIdentity("alice", "bob");
    assert.equal(v.effectiveTrustState, TrustState.VERIFIED);
    assert.equal(v.subjectUserId, "bob");
    assert.match(v.safetyNumber, /^\d{60}$/);
    assert.equal(v.isVerified, true);
    assert.equal(verified, 1);
  });

  it("enforces expected safety number / fingerprint if supplied", async () => {
    const sn = await manager.getSafetyNumber("alice", "bob");
    // correct
    await assert.doesNotReject(() =>
      manager.verifyIdentity("alice", "bob", { expectedSafetyNumber: sn.formatted }),
    );
    // wrong safety number
    await assert.rejects(
      () => manager.verifyIdentity("alice", "bob", { expectedSafetyNumber: "0".repeat(60) }),
      SafetyNumberMismatchError,
    );
    // wrong fingerprint
    await assert.rejects(
      () => manager.verifyIdentity("alice", "bob", { expectedFingerprint: "0".repeat(64) }),
      FingerprintMismatchError,
    );
  });

  it("rejects self-verification and unknown subjects", async () => {
    await assert.rejects(() => manager.verifyIdentity("alice", "alice"), TrustValidationError);
    await assert.rejects(() => manager.verifyIdentity("alice", "ghost"), UnknownIdentityError);
  });

  it("trust / untrust lifecycle with state-machine guards", async () => {
    await assert.rejects(() => manager.trustIdentity("alice", "bob"), VerificationNotFoundError);
    await manager.verifyIdentity("alice", "bob");
    assert.equal((await manager.trustIdentity("alice", "bob")).effectiveTrustState, TrustState.TRUSTED);

    let revoked = 0;
    events.on(TrustEventType.VERIFICATION_REVOKED, () => revoked++);
    assert.equal((await manager.untrustIdentity("alice", "bob")).effectiveTrustState, TrustState.REVOKED);
    assert.equal(revoked, 1);
    // REVOKED → TRUSTED is illegal
    await assert.rejects(() => manager.trustIdentity("alice", "bob"), InvalidTrustTransitionError);
  });

  it("unknown pair status is UNKNOWN", async () => {
    const status = await manager.getVerificationStatus("alice", "bob");
    assert.equal(status.state, TrustState.UNKNOWN);
    assert.equal(status.verification, null);
  });

  describe("identity change detection", () => {
    it("detects a changed identity key → CHANGED + warnings + change log + events", async () => {
      await manager.verifyIdentity("alice", "bob");
      const eventTypes = [];
      events.on("*", (e) => eventTypes.push(e.type));

      store.rotate("bob"); // bob's identity key changes

      const status = await manager.getVerificationStatus("alice", "bob");
      assert.equal(status.state, TrustState.CHANGED);
      const warnTypes = status.warnings.map((w) => w.type);
      assert.ok(warnTypes.includes(TrustWarningType.IDENTITY_CHANGED));
      assert.ok(warnTypes.includes(TrustWarningType.FINGERPRINT_CHANGED));
      assert.ok(eventTypes.includes(TrustEventType.IDENTITY_CHANGED));
      assert.ok(eventTypes.includes(TrustEventType.FINGERPRINT_CHANGED));

      // change log
      const history = await manager.getIdentityHistory("bob");
      assert.equal(history.length, 1);
      assert.equal(history[0].subjectUserId, "bob");

      // getChanges surfaces it
      const changes = await manager.getChanges("alice");
      assert.equal(changes.length, 1);
      assert.equal(changes[0].subjectUserId, "bob");
    });

    it("warns when the subject's identity disappears", async () => {
      await manager.verifyIdentity("alice", "bob");
      store.remove("bob");
      const status = await manager.getVerificationStatus("alice", "bob");
      assert.ok(status.warnings.some((w) => w.type === TrustWarningType.UNKNOWN_IDENTITY));
    });

    it("detects newly added devices (device-add warning)", async () => {
      let bobDevices = ["fp-1"];
      const m = new TrustManager({
        ...repos,
        identityLookup: store.lookup,
        deviceLookup: async (u) => (u === "bob" ? bobDevices : []),
        safetyNumberOptions: FAST_SN,
      });
      await m.verifyIdentity("alice", "bob");
      bobDevices = ["fp-1", "fp-2"]; // bob adds a device
      const status = await m.getVerificationStatus("alice", "bob");
      assert.ok(status.warnings.some((w) => w.type === TrustWarningType.DEVICE_ADDED));
      // fingerprint unchanged → still verified
      assert.equal(status.state, TrustState.VERIFIED);
    });
  });

  describe("QR verification", () => {
    it("verifies via a scanned QR payload", async () => {
      const { serialized } = await manager.generateQrPayload("bob");
      const v = await manager.verifyViaQr("alice", serialized);
      assert.equal(v.effectiveTrustState, TrustState.VERIFIED);
      assert.equal(v.method, "qr");
    });

    it("rejects a QR whose identity no longer matches the current one", async () => {
      const { serialized } = await manager.generateQrPayload("bob");
      store.rotate("bob"); // current identity now differs from the QR
      await assert.rejects(() => manager.verifyViaQr("alice", serialized), FingerprintMismatchError);
    });
  });

  it("lists the caller's verifications", async () => {
    await manager.verifyIdentity("alice", "bob");
    await manager.verifyIdentity("alice", "carol");
    assert.equal((await manager.listVerifications("alice")).length, 2);
    assert.equal((await manager.listVerifications("bob")).length, 0);
  });
});

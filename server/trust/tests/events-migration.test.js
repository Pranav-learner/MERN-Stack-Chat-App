import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TrustEventBus, TrustEventType } from "../events/trustEvents.js";
import { verificationReport } from "../migration/migration.js";
import { TrustManager } from "../manager/trustManager.js";
import { createInMemoryTrustRepositories } from "../repository/inMemoryRepository.js";
import { makeIdentityStore, FAST_SN } from "./helpers.js";

describe("TrustEventBus", () => {
  it("delivers to specific + wildcard listeners; unsubscribe works", () => {
    const bus = new TrustEventBus();
    const specific = [];
    const all = [];
    const off = bus.on(TrustEventType.IDENTITY_VERIFIED, (e) => specific.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(TrustEventType.IDENTITY_VERIFIED, { verifierUser: "a", subjectUser: "b" });
    off();
    bus.emit(TrustEventType.IDENTITY_VERIFIED, { verifierUser: "a", subjectUser: "b" });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
  });
});

describe("migration / verificationReport", () => {
  let store;
  let manager;

  beforeEach(() => {
    store = makeIdentityStore();
    manager = new TrustManager({
      ...createInMemoryTrustRepositories(),
      identityLookup: store.lookup,
      safetyNumberOptions: FAST_SN,
    });
    store.add("alice");
    store.add("bob");
    store.add("carol");
  });

  it("reports verification counts and warnings", async () => {
    await manager.verifyIdentity("alice", "bob");
    await manager.trustIdentity("alice", "bob");
    await manager.verifyIdentity("alice", "carol");
    store.rotate("carol"); // introduces a change/warning

    const report = await verificationReport({ trustManager: manager, userId: "alice" });
    assert.equal(report.verifications, 2);
    assert.equal(report.withWarnings, 1);
    assert.ok(report.byState.trusted >= 1 || report.byState.verified >= 1);
  });
});

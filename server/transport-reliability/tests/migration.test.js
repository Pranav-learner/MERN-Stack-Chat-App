/**
 * Connection migration (Layer 8, Sprint 3): move an in-flight transfer to a new Active Connection
 * (WiFi ↔ mobile, connection replacement), validate + switch via injected Layer-7 hooks, preserve the
 * checkpoint, and drive migration from a connection-loss recovery. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedTransfer, countEvents, makeClock } from "./helpers.js";
import { ConnectionMigrator } from "../migration/connectionMigrator.js";
import { ReliabilityState, MigrationTrigger, MigrationOutcome, RecoveryTrigger, RecoveryOutcome, ReliabilityEventType } from "../types/types.js";

describe("ConnectionMigrator (pure)", () => {
  it("migrates to a validated new connection, preserving the checkpoint", async () => {
    const m = new ConnectionMigrator({ clock: makeClock().now });
    const record = { transferId: "t", connectionId: "conn-1", checkpoint: { chunksAcked: 10 } };
    const res = await m.migrate({ record, newConnectionId: "conn-2", trigger: MigrationTrigger.WIFI_TO_MOBILE });
    assert.equal(res.outcome, MigrationOutcome.MIGRATED);
    assert.equal(res.connectionId, "conn-2");
    assert.equal(res.previousConnectionId, "conn-1");
    assert.equal(res.checkpointPreserved, true);
  });

  it("rejects a migration to the same / missing connection", async () => {
    const m = new ConnectionMigrator();
    assert.equal((await m.migrate({ record: { connectionId: "c1" }, newConnectionId: "c1" })).outcome, MigrationOutcome.REJECTED);
    assert.equal((await m.migrate({ record: { connectionId: "c1" }, newConnectionId: null })).outcome, MigrationOutcome.REJECTED);
  });

  it("rejects when validation fails; fails when the switch fails", async () => {
    const m = new ConnectionMigrator();
    const rec = { connectionId: "c1" };
    assert.equal((await m.migrate({ record: rec, newConnectionId: "c2", hooks: { validateConnection: async () => false } })).outcome, MigrationOutcome.REJECTED);
    assert.equal((await m.migrate({ record: rec, newConnectionId: "c2", hooks: { switchConnection: async () => false } })).outcome, MigrationOutcome.FAILED);
  });

  it("maps a network change to the right trigger", () => {
    assert.equal(ConnectionMigrator.triggerForNetworkChange("wifi", "mobile"), MigrationTrigger.WIFI_TO_MOBILE);
    assert.equal(ConnectionMigrator.triggerForNetworkChange("cellular", "wifi"), MigrationTrigger.MOBILE_TO_WIFI);
    assert.equal(ConnectionMigrator.isMigrationTrigger(RecoveryTrigger.CONNECTION_LOSS), true);
  });
});

describe("manager migration", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("explicitly migrates a transfer (WiFi → mobile), preserving the checkpoint", async () => {
    const id = await seedTransfer(ctx.manager, { connectionId: "wifi-1" });
    const rec = await ctx.manager.migrate(id, "mobile-1", { trigger: MigrationTrigger.WIFI_TO_MOBILE });
    assert.equal(rec.state, ReliabilityState.TRACKING);
    assert.equal(rec.connectionId, "mobile-1");
    assert.equal(rec.migrationCount, 1);
    assert.equal(rec.checkpoint.chunksAcked, 40, "checkpoint preserved across migration");
    assert.equal(ctx.calls.validate.length, 1);
    assert.equal(ctx.calls.switch.length, 1);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.MIGRATION_SUCCEEDED), 1);
  });

  it("recovers a connection-loss by migrating to the new connection then resuming", async () => {
    const id = await seedTransfer(ctx.manager, { connectionId: "conn-1" });
    const res = await ctx.manager.recover(id, RecoveryTrigger.CONNECTION_LOSS, { newConnectionId: "conn-2" });
    assert.equal(res.outcome, RecoveryOutcome.MIGRATED);
    const rec = await ctx.manager.getRecord(id);
    assert.equal(rec.connectionId, "conn-2");
    assert.equal(rec.state, ReliabilityState.TRACKING);
    assert.equal(rec.migrationCount, 1);
  });

  it("a rejected explicit migration throws and leaves the transfer intact", async () => {
    const ctx2 = makeManager({ validateOk: false });
    const id = await seedTransfer(ctx2.manager, { connectionId: "conn-1" });
    await assert.rejects(() => ctx2.manager.migrate(id, "conn-2", { trigger: MigrationTrigger.MANUAL }), /Migration/);
    const rec = await ctx2.manager.getRecord(id);
    assert.equal(rec.connectionId, "conn-1", "still on the original connection");
    assert.equal(rec.checkpoint.chunksAcked, 40, "checkpoint intact");
  });

  it("rejects an unknown migration trigger", async () => {
    const id = await seedTransfer(ctx.manager);
    await assert.rejects(() => ctx.manager.migrate(id, "conn-2", { trigger: "teleport" }), /Unknown migration trigger/);
  });
});

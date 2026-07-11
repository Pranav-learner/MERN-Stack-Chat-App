/**
 * PDP workflow, connection-plan generation, device selection, and lifecycle tests (Layer 6,
 * Sprint 4). Integration tests over real in-memory Discovery + Presence + Capabilities. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makePdp, makeClock, makeIdGen, recordEvents } from "./helpers.js";
import {
  PdpLifecycle,
  ALLOWED_PDP_TRANSITIONS,
  canPdpTransition,
  assertPdpTransition,
  nextPdpStates,
} from "../workflow/lifecycle.js";
import { selectDevices, capabilityScore, resolveSelectionPolicy } from "../selectors/selection.js";
import { createConnectionPlan, isPlanExpired, planCacheKey } from "../planner/connectionPlan.js";
import {
  PdpState,
  PdpEventType,
  PdpFailureReason,
  SelectionPolicy,
  WorkflowStage,
  ALL_PDP_STATES,
  TERMINAL_PDP_STATES,
} from "../types/types.js";
import { InvalidPdpTransitionError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("lifecycle state machine", () => {
  it("walks the happy path created→resolving→negotiating→planning→completed", () => {
    assert.ok(canPdpTransition(PdpState.CREATED, PdpState.RESOLVING));
    assert.ok(canPdpTransition(PdpState.RESOLVING, PdpState.NEGOTIATING));
    assert.ok(canPdpTransition(PdpState.NEGOTIATING, PdpState.PLANNING));
    assert.ok(canPdpTransition(PdpState.PLANNING, PdpState.COMPLETED));
  });

  it("supports failure → recovery → resolving; rejects illegal jumps", () => {
    assert.ok(canPdpTransition(PdpState.FAILED, PdpState.RECOVERY));
    assert.ok(canPdpTransition(PdpState.RECOVERY, PdpState.RESOLVING));
    assert.ok(!canPdpTransition(PdpState.CREATED, PdpState.COMPLETED));
    assert.throws(() => assertPdpTransition(PdpState.COMPLETED, PdpState.RESOLVING), InvalidPdpTransitionError);
  });

  it("terminal states (except failed→recovery) are dead ends; all states mapped", () => {
    for (const t of TERMINAL_PDP_STATES) {
      if (t === PdpState.FAILED) continue;
      assert.deepEqual(nextPdpStates(t), []);
    }
    for (const s of ALL_PDP_STATES) assert.ok(s in ALLOWED_PDP_TRANSITIONS);
  });

  it("PdpLifecycle records history + enforces legality", () => {
    const fsm = new PdpLifecycle(PdpState.CREATED, { clock: makeClock() });
    fsm.transition(PdpState.RESOLVING);
    fsm.transition(PdpState.NEGOTIATING, { reason: "caps" });
    assert.equal(fsm.state, PdpState.NEGOTIATING);
    assert.equal(fsm.history.length, 2);
    assert.throws(() => fsm.transition(PdpState.COMPLETED), InvalidPdpTransitionError);
  });
});

// ---------------------------------------------------------------------------
describe("device selection engine", () => {
  const cand = (deviceId, over = {}) => ({
    deviceId,
    presenceStatus: "online",
    lastSeen: "2026-01-01T00:00:00.000Z",
    capabilities: { compatible: true, protocolVersion: "1.0", cryptoVersion: "1.0", sharedTransports: ["relay"], preferredTransport: "relay", compression: "gzip", featureFlags: { typing: true }, relay: true },
    ...over,
  });

  it("capability-score ranks richer capabilities higher; deterministic tie-break by deviceId", () => {
    const rich = cand("b", { capabilities: { compatible: true, protocolVersion: "1.0", cryptoVersion: "1.0", sharedTransports: ["webrtc", "relay", "websocket"], preferredTransport: "webrtc", compression: "gzip", featureFlags: { typing: true, reactions: true }, relay: true } });
    const poor = cand("a", { capabilities: { compatible: true, protocolVersion: "1.0", cryptoVersion: "1.0", sharedTransports: ["websocket"], preferredTransport: "websocket", compression: "none", featureFlags: {}, relay: false } });
    const selected = selectDevices([poor, rich], { policy: SelectionPolicy.CAPABILITY_SCORE });
    assert.equal(selected[0].deviceId, "b"); // richer wins
    assert.ok(selected[0].score > selected[1].score);
    assert.equal(selected[0].rank, 0);
  });

  it("user-preference picks the requested device", () => {
    const selected = selectDevices([cand("a"), cand("z")], { policy: SelectionPolicy.USER_PREFERENCE, options: { preferredDeviceId: "z" } });
    assert.equal(selected[0].deviceId, "z");
  });

  it("platform-preference picks the requested platform", () => {
    const selected = selectDevices([cand("a", { platform: "web" }), cand("b", { platform: "ios" })], { policy: SelectionPolicy.PLATFORM_PREFERENCE, options: { preferredPlatform: "ios" } });
    assert.equal(selected[0].deviceId, "b");
  });

  it("newest-active prefers the most recently seen", () => {
    const now = new Date("2026-01-01T01:00:00.000Z").getTime();
    const old = cand("a", { lastSeen: "2026-01-01T00:00:00.000Z" });
    const fresh = cand("b", { lastSeen: "2026-01-01T00:59:00.000Z" });
    const selected = selectDevices([old, fresh], { policy: SelectionPolicy.NEWEST_ACTIVE, now });
    assert.equal(selected[0].deviceId, "b");
  });

  it("caps the selected set + resolveSelectionPolicy falls back to default", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => cand(id));
    assert.equal(selectDevices(many, { maxDevices: 2 }).length, 2);
    assert.equal(resolveSelectionPolicy("bogus"), SelectionPolicy.CAPABILITY_SCORE);
    assert.ok(capabilityScore(cand("a").capabilities ? cand("a") : {}) >= 0);
  });
});

// ---------------------------------------------------------------------------
describe("connection plan builder", () => {
  it("assembles a plan from selected devices + presence snapshot", () => {
    const clock = makeClock();
    const selected = [{ deviceId: "d1", capabilities: { protocolVersion: "1.0", cryptoVersion: "1.0", preferredTransport: "webrtc", fallbackChain: ["relay"] }, score: 0.8, rank: 0, priority: 80 }];
    const plan = createConnectionPlan({
      discoveryId: "disc-1", requester: "u1", requesterDevice: "d1", targetUser: "u2",
      selectedDevices: selected, presenceSnapshot: [{ deviceId: "d1", status: "online", lastSeen: null }],
      selectionPolicy: "capability-score", ttlMs: 60_000, clock, idGenerator: makeIdGen(),
    });
    assert.equal(plan.primaryDeviceId, "d1");
    assert.equal(plan.preferredTransport, "webrtc");
    assert.deepEqual(plan.fallbackTransports, ["relay"]);
    assert.equal(plan.cryptoCompatible, true);
    assert.equal(plan.connection.reserved, true); // inert placeholder
    assert.equal(plan.nat.reserved, true);
    assert.ok(!isPlanExpired(plan, clock()));
    assert.ok(isPlanExpired(plan, clock() + 120_000));
  });

  it("planCacheKey is stable + order-independent for device subsets", () => {
    const a = planCacheKey({ requester: "u1", requesterDevice: "d1", targetUser: "u2", selectionPolicy: "x", targetDevices: ["b", "a"] });
    const b = planCacheKey({ requester: "u1", requesterDevice: "d1", targetUser: "u2", selectionPolicy: "x", targetDevices: ["a", "b"] });
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
describe("end-to-end workflow", () => {
  let ctx;
  beforeEach(async () => {
    ctx = makePdp();
    await ctx.registerRequester("u1", "d1");
    await ctx.seedUser("u2", [
      { deviceId: "u2-laptop", transports: ["webrtc", "relay"], platform: "web" },
      { deviceId: "u2-phone", transports: ["websocket"], platform: "ios" },
    ]);
  });

  it("runs identity→devices→presence→capabilities→selection→plan and completes", async () => {
    const log = recordEvents(ctx.events);
    const { session, plan, source } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    assert.equal(session.state, PdpState.COMPLETED);
    assert.equal(session.stage, WorkflowStage.PLAN);
    assert.equal(source, "computed");
    assert.equal(plan.primaryDeviceId, "u2-laptop"); // webrtc → higher capability score than phone
    assert.equal(plan.preferredTransport, "webrtc");
    assert.equal(plan.presenceSnapshot.length, 2);
    assert.equal(plan.cryptoCompatible, true);

    // Full semantic event trail.
    const types = new Set(log.types());
    for (const e of [PdpEventType.DISCOVERY_REQUESTED, PdpEventType.DISCOVERY_RESOLVED, PdpEventType.PRESENCE_RESOLVED, PdpEventType.CAPABILITIES_NEGOTIATED, PdpEventType.DEVICE_SELECTED, PdpEventType.CONNECTION_PLAN_CREATED, PdpEventType.WORKFLOW_COMPLETED]) {
      assert.ok(types.has(e), `missing event ${e}`);
    }
    // Stage history recorded for every stage.
    const stages = new Set(session.stageHistory.map((h) => h.stage));
    for (const s of Object.values(WorkflowStage)) assert.ok(stages.has(s), `missing stage ${s}`);
  });

  it("selecting a device subset restricts candidates", async () => {
    const { plan } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevices: ["u2-phone"] });
    assert.equal(plan.selectedDevices.length, 1);
    assert.equal(plan.primaryDeviceId, "u2-phone");
    assert.equal(plan.preferredTransport, "websocket");
  });

  it("honours the selection policy (user-preference)", async () => {
    const { plan } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2", selectionPolicy: SelectionPolicy.USER_PREFERENCE, selectionOptions: { preferredDeviceId: "u2-phone" } });
    assert.equal(plan.primaryDeviceId, "u2-phone");
  });
});

// ---------------------------------------------------------------------------
describe("workflow failure handling", () => {
  it("unknown user fails at the identity stage", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("u1", "d1");
    const { session, plan } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "ghost" });
    assert.equal(session.state, PdpState.FAILED);
    assert.equal(session.failureReason, PdpFailureReason.UNKNOWN_USER);
    assert.equal(session.stage, WorkflowStage.IDENTITY);
    assert.equal(plan, null);
  });

  it("no discoverable devices fails at the devices stage", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("u1", "d1");
    ctx.directory.set("u2", { identity: { identityId: "id-u2", publicKey: "P", fingerprint: "f" }, devices: [] });
    const { session } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    assert.equal(session.failureReason, PdpFailureReason.NO_DISCOVERABLE_DEVICES);
  });

  it("no reachable devices fails at the presence stage", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("u1", "d1");
    await ctx.seedUser("u2", [{ deviceId: "u2-d1", present: false }]); // discoverable but offline
    const { session } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    assert.equal(session.state, PdpState.FAILED);
    assert.equal(session.failureReason, PdpFailureReason.NO_ACTIVE_DEVICES);
    assert.equal(session.stage, WorkflowStage.PRESENCE);
  });

  it("no capability-compatible reachable device fails at the capabilities stage", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("u1", "d1", { transports: ["webrtc"] }); // requester only speaks webrtc
    await ctx.seedUser("u2", [{ deviceId: "u2-d1", transports: ["websocket"] }]); // peer only websocket → no shared
    const { session } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    assert.equal(session.failureReason, PdpFailureReason.CAPABILITY_CONFLICT);
    assert.equal(session.stage, WorkflowStage.CAPABILITIES);
  });
});

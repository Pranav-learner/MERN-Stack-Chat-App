import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeviceEventBus, DeviceEventType } from "../events/deviceEvents.js";

describe("DeviceEventBus", () => {
  it("delivers events to type-specific and wildcard listeners", () => {
    const bus = new DeviceEventBus();
    const specific = [];
    const all = [];
    bus.on(DeviceEventType.REGISTERED, (e) => specific.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(DeviceEventType.REGISTERED, { deviceId: "d1", userId: "u1" });
    bus.emit(DeviceEventType.REVOKED, { deviceId: "d1", userId: "u1" });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
    assert.equal(specific[0].type, DeviceEventType.REGISTERED);
    assert.ok(typeof specific[0].at === "number");
  });

  it("unsubscribe stops delivery", () => {
    const bus = new DeviceEventBus();
    const seen = [];
    const off = bus.on(DeviceEventType.UPDATED, (e) => seen.push(e));
    bus.emit(DeviceEventType.UPDATED, { deviceId: "d", userId: "u" });
    off();
    bus.emit(DeviceEventType.UPDATED, { deviceId: "d", userId: "u" });
    assert.equal(seen.length, 1);
  });

  it("once fires a single time", () => {
    const bus = new DeviceEventBus();
    let count = 0;
    bus.once(DeviceEventType.ACTIVATED, () => count++);
    bus.emit(DeviceEventType.ACTIVATED, { deviceId: "d", userId: "u" });
    bus.emit(DeviceEventType.ACTIVATED, { deviceId: "d", userId: "u" });
    assert.equal(count, 1);
  });
});

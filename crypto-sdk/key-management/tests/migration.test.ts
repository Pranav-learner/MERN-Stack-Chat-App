import { describe, it, expect } from "vitest";
import {
  MigrationRegistry,
  MigrationError,
  KeySerializer,
  UnsupportedVersionError,
  type SerializedKey,
} from "../src/index.js";
import { makeIdentityKey } from "./helpers.js";

describe("MigrationRegistry", () => {
  it("starts empty and chains registered step migrations", () => {
    const registry = new MigrationRegistry();
    expect(registry.isEmpty).toBe(true);

    registry
      .register({ fromVersion: 1, toVersion: 2, migrate: (k) => ({ ...k, formatVersion: 2 }) })
      .register({ fromVersion: 2, toVersion: 3, migrate: (k) => ({ ...k, formatVersion: 3 }) });

    const v1 = { formatVersion: 1 } as SerializedKey;
    expect(registry.migrate(v1, 3)?.formatVersion).toBe(3);
    expect(registry.migrate(v1, 2)?.formatVersion).toBe(2);
  });

  it("returns null when no path exists", () => {
    const registry = new MigrationRegistry();
    expect(registry.migrate({ formatVersion: 1 } as SerializedKey, 5)).toBeNull();
  });

  it("rejects backwards or duplicate migrations", () => {
    const registry = new MigrationRegistry();
    expect(() => registry.register({ fromVersion: 2, toVersion: 1, migrate: (k) => k })).toThrow(
      MigrationError,
    );
    registry.register({ fromVersion: 1, toVersion: 2, migrate: (k) => k });
    expect(() => registry.register({ fromVersion: 1, toVersion: 3, migrate: (k) => k })).toThrow(
      MigrationError,
    );
  });

  it("wraps a throwing migration step in MigrationError", () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: 1,
      toVersion: 2,
      migrate: () => {
        throw new Error("boom");
      },
    });
    expect(() => registry.migrate({ formatVersion: 1 } as SerializedKey, 2)).toThrow(
      MigrationError,
    );
  });

  it("the serializer uses the registry to upgrade an older format", () => {
    const registry = new MigrationRegistry();
    // Simulate a v0 payload being upgraded to the current v1 by re-stamping and
    // recomputing integrity from the real serializer.
    const real = new KeySerializer();
    const current = real.serialize(makeIdentityKey("o", "k1"));
    const downgraded = { ...current, formatVersion: 0 };
    registry.register({
      fromVersion: 0,
      toVersion: 1,
      migrate: () => current, // produce a valid v1 with correct integrity
    });
    const migratingSerializer = new KeySerializer(registry);
    const key = migratingSerializer.deserialize(downgraded as unknown as SerializedKey);
    expect(key.keyId).toBe("k1");
  });

  it("serializer without a matching migration throws UnsupportedVersionError", () => {
    const serializer = new KeySerializer(new MigrationRegistry());
    const current = serializer.serialize(makeIdentityKey("o", "k1"));
    expect(() => serializer.deserialize({ ...current, formatVersion: 7 })).toThrow(
      UnsupportedVersionError,
    );
  });
});

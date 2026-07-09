/**
 * @module migration
 *
 * Forward-migration framework for serialized key formats. Today only
 * `formatVersion === 1` exists, so the registry ships empty — but the machinery
 * is in place so a future format bump can register a migration without changing
 * the serializer or any consumer.
 */

import type { SerializedKey } from "../types/index.js";
import { MigrationError } from "../errors/index.js";

/** A single-step migration between two adjacent format versions. */
export interface Migration {
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Transform a serialized key from `fromVersion` to `toVersion`. */
  migrate(input: SerializedKey): SerializedKey;
}

/**
 * Registry that chains step migrations to reach a target version.
 *
 * @example
 * ```ts
 * const registry = new MigrationRegistry();
 * registry.register({ fromVersion: 1, toVersion: 2, migrate: (k) => ({ ...k, formatVersion: 2 }) });
 * const upgraded = registry.migrate(oldKey, 2);
 * ```
 */
export class MigrationRegistry {
  private readonly byFrom = new Map<number, Migration>();

  /** Register a step migration. @throws {MigrationError} on a duplicate `fromVersion`. */
  register(migration: Migration): this {
    if (migration.toVersion <= migration.fromVersion) {
      throw new MigrationError("Migration must move forward (toVersion > fromVersion)", {
        details: { fromVersion: migration.fromVersion, toVersion: migration.toVersion },
      });
    }
    if (this.byFrom.has(migration.fromVersion)) {
      throw new MigrationError(
        `A migration from version ${migration.fromVersion} is already registered`,
      );
    }
    this.byFrom.set(migration.fromVersion, migration);
    return this;
  }

  /**
   * Migrate `input` up to `targetVersion` by chaining registered steps.
   * @returns the migrated key, or `null` if no path exists.
   * @throws {MigrationError} if a step throws.
   */
  migrate(input: SerializedKey, targetVersion: number): SerializedKey | null {
    let current = input;
    const guard = 100; // avoid infinite loops from mis-registered migrations
    let steps = 0;
    while (current.formatVersion < targetVersion) {
      const step = this.byFrom.get(current.formatVersion);
      if (!step) return null;
      try {
        current = step.migrate(current);
      } catch (cause) {
        throw new MigrationError(`Migration ${step.fromVersion} -> ${step.toVersion} failed`, {
          cause,
        });
      }
      if (++steps > guard) {
        throw new MigrationError("Migration exceeded maximum step count (possible cycle)");
      }
    }
    return current.formatVersion === targetVersion ? current : null;
  }

  /** Whether any migrations are registered. */
  get isEmpty(): boolean {
    return this.byFrom.size === 0;
  }
}

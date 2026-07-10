/**
 * @module session-evolution/evolution/generations
 *
 * **Session Versioning** — the generation timeline logic. A generation is a monotonic
 * counter marking a point at which a session's key material WOULD be rotated. In Sprint
 * 1 no keys move; only the counter, the key-version pointers, and the version history
 * advance. Later Layer 5 sprints attach real derived keys to each generation.
 *
 * Provides: building version-history entries, monotonic-advance validation, duplicate
 * detection, current/previous/next lookups, migration snapshots, and rollback metadata.
 *
 * @security Pure metadata logic — no key bytes, no crypto. Generation numbers are
 * PUBLIC.
 */

import { INITIAL_GENERATION, EvolutionTrigger } from "../types/types.js";
import { InvalidGenerationError, DuplicateGenerationError } from "../errors.js";

/** Whether `n` is a valid generation number (a non-negative integer). */
export function isValidGeneration(n) {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Assert a proposed advance is monotonic by exactly one step (no gaps, no regressions).
 * @param {number} current @param {number} next @throws {InvalidGenerationError}
 */
export function assertMonotonicAdvance(current, next) {
  if (!isValidGeneration(current) || !isValidGeneration(next)) {
    throw new InvalidGenerationError("Generation numbers must be non-negative integers", {
      details: { current, next },
    });
  }
  if (next !== current + 1) {
    throw new InvalidGenerationError(`Generation must advance by exactly one (from ${current} to ${current + 1})`, {
      details: { current, next, expected: current + 1 },
    });
  }
}

/**
 * Assert a generation does not already exist in the version history.
 * @param {import("../types/types.js").VersionHistoryEntry[]} history @param {number} generation
 * @throws {DuplicateGenerationError}
 */
export function assertNoDuplicateGeneration(history, generation) {
  if ((history ?? []).some((h) => h.generation === generation)) {
    throw new DuplicateGenerationError(`Generation ${generation} already exists in the timeline`, {
      details: { generation },
    });
  }
}

/**
 * Build a version-history entry for a generation advance.
 * @param {object} params
 * @param {number} params.generation the new generation
 * @param {number} params.keyVersion the new key version
 * @param {number} [params.previousGeneration] @param {number|null} [params.previousKeyVersion]
 * @param {string} [params.trigger] one of {@link EvolutionTrigger}
 * @param {string} [params.reason] @param {string} [params.at] ISO timestamp
 * @returns {import("../types/types.js").VersionHistoryEntry}
 */
export function buildVersionEntry(params) {
  const entry = {
    generation: params.generation,
    keyVersion: params.keyVersion,
    at: params.at ?? new Date().toISOString(),
    trigger: params.trigger ?? EvolutionTrigger.SYSTEM,
  };
  if (params.previousGeneration !== undefined) entry.previousGeneration = params.previousGeneration;
  if (params.previousKeyVersion !== undefined) entry.previousKeyVersion = params.previousKeyVersion;
  if (params.reason !== undefined) entry.reason = params.reason;
  return entry;
}

/** The current (latest) generation from a record, defaulting to the initial generation. */
export function currentGeneration(record) {
  return record?.generation ?? INITIAL_GENERATION;
}

/** The generation immediately before the current one, or null if there is none. */
export function previousGeneration(record) {
  const history = record?.versionHistory ?? [];
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  return last.previousGeneration ?? null;
}

/** The planned next generation (`current + 1`) — a projection, not yet applied. */
export function futureGeneration(record) {
  return currentGeneration(record) + 1;
}

/**
 * A compact, ordered snapshot of the generation timeline — useful for migration and
 * for a client to reconcile which generations it has seen.
 * @param {import("../types/types.js").EvolutionRecord} record
 * @returns {{ current: number, count: number, generations: number[] }}
 */
export function migrationSnapshot(record) {
  const generations = (record?.versionHistory ?? []).map((h) => h.generation);
  return {
    current: currentGeneration(record),
    count: generations.length,
    generations,
  };
}

/**
 * Rollback METADATA for the last advance — describes how to interpret a rollback WITHOUT
 * performing one (no keys are restored in Sprint 1). Returns null when there is nothing
 * to roll back to.
 * @param {import("../types/types.js").EvolutionRecord} record
 * @returns {{ from: number, to: number, keyVersionFrom: number, keyVersionTo: number|null, at: string, reversible: boolean }|null}
 */
export function rollbackMetadata(record) {
  const history = record?.versionHistory ?? [];
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  return {
    from: last.generation,
    to: last.previousGeneration ?? INITIAL_GENERATION,
    keyVersionFrom: last.keyVersion,
    keyVersionTo: last.previousKeyVersion ?? null,
    at: last.at,
    // Metadata rollback is representable; actual key rollback is a FUTURE concern and is
    // intentionally NOT performed by this framework.
    reversible: false,
  };
}

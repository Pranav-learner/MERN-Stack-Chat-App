/**
 * @module rotation
 *
 * A reusable rotation *framework*. It decides WHEN keys should rotate and tracks
 * version/history — it never rotates automatically and starts no timers. The
 * {@link KeyManager} performs the actual re-keying when asked.
 *
 * Pieces:
 * - {@link RotationPolicy} — pluggable "should this key rotate?" predicate.
 * - Built-in policies: never / manual / age-based / usage-based / expiry / composite.
 * - {@link RotationScheduler} — evaluates a set of keys against a policy (pure).
 * - {@link RotationSchedulerDriver} — abstraction for a future timer-based runner.
 * - {@link buildHistoryChain} — reconstructs a key's rotation lineage.
 */

import type { ManagedKey } from "../managed-key.js";
import type { KeyMetadata } from "../types/index.js";
import { isExpired } from "../metadata/index.js";

/** Runtime context passed to a policy evaluation. */
export interface RotationContext {
  /** Epoch ms "now" (default: system clock at evaluation time). */
  now?: number;
  /** Observed usage count for the key (overrides metadata.custom.usageCount). */
  usageCount?: number;
}

/** A pluggable rotation decision policy. */
export interface RotationPolicy {
  readonly name: string;
  /** Whether `key` is due for rotation under this policy. */
  shouldRotate(key: ManagedKey, context?: RotationContext): boolean;
  /** Human-readable description (for diagnostics/scheduling reports). */
  describe(): string;
}

/** Never rotate. */
export class NeverRotatePolicy implements RotationPolicy {
  readonly name = "never";
  shouldRotate(_key: ManagedKey, _context?: RotationContext): boolean {
    return false;
  }
  describe(): string {
    return "Never rotate automatically.";
  }
}

/**
 * Manual-only rotation: automatic evaluation always returns false, signalling
 * that rotation must be triggered explicitly by an operator/caller.
 */
export class ManualRotationPolicy implements RotationPolicy {
  readonly name = "manual";
  shouldRotate(_key: ManagedKey, _context?: RotationContext): boolean {
    return false;
  }
  describe(): string {
    return "Rotate only when explicitly requested.";
  }
}

/** Rotate once a key is older than `maxAgeMs` (based on `createdAt`). */
export class AgeBasedRotationPolicy implements RotationPolicy {
  readonly name = "age-based";
  constructor(private readonly maxAgeMs: number) {
    if (maxAgeMs <= 0) throw new RangeError("maxAgeMs must be > 0");
  }
  shouldRotate(key: ManagedKey, context?: RotationContext): boolean {
    const now = context?.now ?? Date.now();
    const created = Date.parse(key.metadata.createdAt);
    if (Number.isNaN(created)) return false;
    return now - created >= this.maxAgeMs;
  }
  describe(): string {
    return `Rotate keys older than ${this.maxAgeMs} ms.`;
  }
}

/** Rotate once a key's observed usage count reaches `maxUsage`. */
export class UsageBasedRotationPolicy implements RotationPolicy {
  readonly name = "usage-based";
  constructor(private readonly maxUsage: number) {
    if (maxUsage <= 0) throw new RangeError("maxUsage must be > 0");
  }
  shouldRotate(key: ManagedKey, context?: RotationContext): boolean {
    const usage =
      context?.usageCount ??
      (typeof key.metadata.custom?.usageCount === "number"
        ? (key.metadata.custom.usageCount as number)
        : 0);
    return usage >= this.maxUsage;
  }
  describe(): string {
    return `Rotate keys after ${this.maxUsage} uses.`;
  }
}

/** Rotate once a key is past its `expiresAt`. */
export class ExpiryRotationPolicy implements RotationPolicy {
  readonly name = "expiry";
  shouldRotate(key: ManagedKey, context?: RotationContext): boolean {
    return isExpired(key.metadata, context?.now ?? Date.now());
  }
  describe(): string {
    return "Rotate keys that have passed their expiry.";
  }
}

/** Combine policies with `any` (default) or `all` semantics. */
export class CompositeRotationPolicy implements RotationPolicy {
  readonly name = "composite";
  constructor(
    private readonly policies: RotationPolicy[],
    private readonly mode: "any" | "all" = "any",
  ) {
    if (policies.length === 0) throw new RangeError("composite policy needs at least one policy");
  }
  shouldRotate(key: ManagedKey, context?: RotationContext): boolean {
    return this.mode === "any"
      ? this.policies.some((p) => p.shouldRotate(key, context))
      : this.policies.every((p) => p.shouldRotate(key, context));
  }
  describe(): string {
    return `Rotate if ${this.mode} of: [${this.policies.map((p) => p.name).join(", ")}].`;
  }
}

/** The outcome of evaluating one key against a policy. */
export interface RotationDecision {
  keyId: string;
  shouldRotate: boolean;
  policy: string;
  reason: string;
}

/**
 * Pure evaluator: given keys + a policy, report which are due. Does NOT rotate.
 *
 * @example
 * ```ts
 * const scheduler = new RotationScheduler();
 * const due = scheduler.evaluate(keys, new AgeBasedRotationPolicy(30 * 864e5))
 *   .filter((d) => d.shouldRotate);
 * ```
 */
export class RotationScheduler {
  evaluate(
    keys: ManagedKey[],
    policy: RotationPolicy,
    context?: RotationContext,
  ): RotationDecision[] {
    return keys.map((key) => {
      const shouldRotate = policy.shouldRotate(key, context);
      return {
        keyId: key.keyId,
        shouldRotate,
        policy: policy.name,
        reason: shouldRotate ? policy.describe() : "not due",
      };
    });
  }
}

/**
 * Abstraction for a future timer/cron-driven rotation runner. Sprint 2 ships only
 * the interface and a {@link NoopSchedulerDriver}; no timers are started.
 */
export interface RotationSchedulerDriver {
  readonly name: string;
  /** Begin periodic evaluation (future). */
  start(): void;
  /** Stop periodic evaluation (future). */
  stop(): void;
  readonly running: boolean;
}

/** A driver that does nothing — placeholder for future automated scheduling. */
export class NoopSchedulerDriver implements RotationSchedulerDriver {
  readonly name = "noop";
  private _running = false;
  start(): void {
    this._running = true;
  }
  stop(): void {
    this._running = false;
  }
  get running(): boolean {
    return this._running;
  }
}

/** One node in a key's rotation lineage. */
export interface KeyHistoryEntry {
  keyId: string;
  version: number;
  status: KeyMetadata["status"];
  createdAt: string;
  previousKeyId?: string;
}

/**
 * Reconstruct the rotation lineage ending at `keyId` by following `previousKeyId`
 * links through the provided key set. Returned oldest-first.
 *
 * @param keyId the newest key in the chain to trace back from.
 * @param keysById a lookup of all candidate keys.
 */
export function buildHistoryChain(
  keyId: string,
  keysById: Map<string, ManagedKey>,
): KeyHistoryEntry[] {
  const chain: KeyHistoryEntry[] = [];
  const seen = new Set<string>();
  let current: string | undefined = keyId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const key = keysById.get(current);
    if (!key) break;
    const entry: KeyHistoryEntry = {
      keyId: key.metadata.keyId,
      version: key.metadata.version,
      status: key.metadata.status,
      createdAt: key.metadata.createdAt,
    };
    if (key.metadata.previousKeyId !== undefined) entry.previousKeyId = key.metadata.previousKeyId;
    chain.push(entry);
    current = key.metadata.previousKeyId;
  }
  return chain.reverse();
}

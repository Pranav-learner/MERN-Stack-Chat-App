/**
 * @module networking-hardening/repository
 *
 * **Repository hardening** — wraps any Layer-6 repository (discovery sessions, presence records,
 * capability sets, connection plans, …) so its methods gain production resilience WITHOUT changing
 * the repository contract: bounded retry-with-backoff on transient failures, a **circuit breaker**
 * that fails fast while a backend is down (then probes to recover), operation timing, and
 * failure/latency metrics. The wrapped object is a drop-in for the original.
 *
 * @security Operates on the storage layer only — no key material. It never alters query results;
 * it only governs *how* a call is made (retry / short-circuit / time).
 *
 * @distributed The circuit breaker is per-instance; in a fleet each instance protects itself from a
 * flapping backend. Combined with the idempotency store, retried writes stay safe.
 *
 * @example
 * ```js
 * const sessions = wrapRepository(rawSessions, { metrics, events, retryPolicy: { maxAttempts: 3 } });
 * await sessions.findById(id); // retried + circuit-protected + timed
 * ```
 */

import { CircuitState, HardeningEventType, Metric, DEFAULT_RETRY_POLICY, DEFAULT_CIRCUIT_CONFIG } from "../types/types.js";
import { CircuitOpenError } from "../errors.js";
import { HardeningEventBus } from "../events/events.js";

/** A per-target circuit breaker: CLOSED → (failures) → OPEN → (cooldown) → HALF_OPEN → CLOSED. */
export class CircuitBreaker {
  /** @param {object} [config] @param {() => number} [config.clock] @param {HardeningEventBus} [config.events] @param {object} [config.metrics] @param {string} [config.name] */
  constructor(config = {}) {
    this.failureThreshold = config.failureThreshold ?? DEFAULT_CIRCUIT_CONFIG.failureThreshold;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_CIRCUIT_CONFIG.cooldownMs;
    this.halfOpenMax = config.halfOpenMax ?? DEFAULT_CIRCUIT_CONFIG.halfOpenMax;
    this.clock = config.clock ?? (() => Date.now());
    this.events = config.events ?? null;
    this.metrics = config.metrics ?? null;
    this.name = config.name ?? "repository";
    this._state = CircuitState.CLOSED;
    this._failures = 0;
    this._openedAt = 0;
    this._halfOpenInFlight = 0;
  }

  /** @returns {string} current circuit state (transitions to HALF_OPEN when the cooldown elapses). */
  get state() {
    if (this._state === CircuitState.OPEN && this.clock() - this._openedAt >= this.cooldownMs) {
      this._state = CircuitState.HALF_OPEN;
      this._halfOpenInFlight = 0;
    }
    return this._state;
  }

  /** Run `fn` under the breaker. @throws {CircuitOpenError} when open. */
  async exec(fn) {
    const state = this.state;
    if (state === CircuitState.OPEN) throw new CircuitOpenError(`Circuit "${this.name}" is open`, { details: { name: this.name } });
    if (state === CircuitState.HALF_OPEN) {
      if (this._halfOpenInFlight >= this.halfOpenMax) throw new CircuitOpenError(`Circuit "${this.name}" is half-open (probe in flight)`, { details: { name: this.name } });
      this._halfOpenInFlight++;
    }
    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    } finally {
      if (state === CircuitState.HALF_OPEN) this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
    }
  }

  /** @private */
  _onSuccess() {
    if (this._state !== CircuitState.CLOSED) {
      this._state = CircuitState.CLOSED;
      this.events?.emit(HardeningEventType.CIRCUIT_CLOSED, { subsystem: this.name });
    }
    this._failures = 0;
  }

  /** @private */
  _onFailure() {
    this._failures++;
    if (this._failures >= this.failureThreshold && this._state !== CircuitState.OPEN) {
      this._state = CircuitState.OPEN;
      this._openedAt = this.clock();
      this.metrics?.increment(Metric.CIRCUIT_OPEN_TOTAL, 1, { name: this.name });
      this.events?.emit(HardeningEventType.CIRCUIT_OPENED, { subsystem: this.name, count: this._failures });
    }
  }
}

/** Bounded exponential-backoff retry (shared with the recovery coordinator's policy shape). */
async function withRetry(fn, policy, sleep) {
  const { maxAttempts, baseDelayMs, maxDelayMs, factor } = policy;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Never retry a fail-fast circuit-open signal.
      if (error?.code === "ERR_NETHARD_CIRCUIT_OPEN" || attempt === maxAttempts) break;
      await sleep(Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1)));
    }
  }
  throw lastError;
}

/**
 * Wrap a repository so every async method gains retry + circuit-breaker + timing.
 *
 * @param {object} repo the repository to harden
 * @param {object} [deps]
 * @param {import("../observability/metrics.js").NetworkingMetrics} [deps.metrics]
 * @param {HardeningEventBus} [deps.events] @param {() => number} [deps.clock]
 * @param {object} [deps.retryPolicy] @param {object} [deps.circuit] @param {string} [deps.name]
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @returns {object} a hardened repository with the same method surface
 */
export function wrapRepository(repo, deps = {}) {
  const metrics = deps.metrics ?? null;
  const clock = deps.clock ?? (() => Date.now());
  const retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(deps.retryPolicy ?? {}) };
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const breaker = new CircuitBreaker({ ...deps.circuit, clock, events: deps.events, metrics, name: deps.name ?? "repository" });

  const hardened = { __breaker: breaker };
  for (const key of allMethodNames(repo)) {
    const original = repo[key];
    if (typeof original !== "function") continue;
    hardened[key] = async (...args) => {
      const start = clock();
      try {
        const result = await withRetry(() => breaker.exec(() => original.apply(repo, args)), retryPolicy, sleep);
        metrics?.observe(Metric.REPOSITORY_LATENCY, clock() - start, { op: key });
        return result;
      } catch (error) {
        metrics?.increment(Metric.REPOSITORY_FAILURE, 1, { op: key });
        metrics?.observe(Metric.REPOSITORY_LATENCY, clock() - start, { op: key });
        throw error;
      }
    };
  }
  return hardened;
}

/** Collect own + prototype method names (repositories are often plain objects of async fns). */
function allMethodNames(obj) {
  const names = new Set(Object.keys(obj));
  let proto = Object.getPrototypeOf(obj);
  while (proto && proto !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(proto)) if (n !== "constructor") names.add(n);
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

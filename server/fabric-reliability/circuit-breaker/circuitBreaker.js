/**
 * @module fabric-reliability/circuit-breaker/circuitBreaker
 *
 * A **Circuit Breaker** (STEP 5) — protects a fabric operation from cascading failure. It counts failures
 * in a rolling window; when they cross the threshold it TRIPS OPEN and rejects calls fast (no waiting on a
 * failing dependency). After a reset timeout it goes HALF-OPEN and admits a limited trial; enough
 * consecutive trial successes CLOSE it, any trial failure re-OPENS it. Only circuit-tripping failure
 * classes (transient / timeout / resource) count — validation + authorization errors are the caller's
 * fault and never trip the breaker.
 *
 * Time is injected (a `clock`), so state transitions are deterministic + testable; the OPEN→HALF-OPEN
 * transition happens lazily on the next `canPass()` once the clock has advanced past the reset timeout.
 *
 * @security Reasons over failure counts + classes only. No content.
 */

import { CircuitState, CIRCUIT_TRIPPING_CLASSES, DEFAULT_CIRCUIT, ReliabilityEventType } from "../types/types.js";
import { CircuitOpenError } from "../errors.js";

export class CircuitBreaker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name] identifier (operation kind / compartment)
   * @param {number} [opts.failureThreshold] failures in-window to trip @param {number} [opts.successThreshold] half-open successes to close
   * @param {number} [opts.resetTimeoutMs] OPEN duration before a trial @param {number} [opts.rollingWindowMs] failure-count window
   * @param {import("../events/events.js").FabricReliabilityEventBus} [opts.events] @param {() => number} [opts.clock]
   */
  constructor(opts = {}) {
    this.name = opts.name ?? "default";
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_CIRCUIT.failureThreshold;
    this.successThreshold = opts.successThreshold ?? DEFAULT_CIRCUIT.successThreshold;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? DEFAULT_CIRCUIT.resetTimeoutMs;
    this.rollingWindowMs = opts.rollingWindowMs ?? DEFAULT_CIRCUIT.rollingWindowMs;
    this.events = opts.events ?? null;
    this.clock = opts.clock ?? (() => Date.now());

    this.state = CircuitState.CLOSED;
    this._failures = []; // timestamps of recent tripping failures
    this._halfOpenSuccesses = 0;
    this._openedAt = null;
    this._trips = 0;
  }

  /** Whether a call may pass now. Lazily transitions OPEN→HALF-OPEN once the reset timeout has elapsed. */
  canPass() {
    if (this.state === CircuitState.OPEN) {
      if (this.clock() - this._openedAt >= this.resetTimeoutMs) {
        this._transition(CircuitState.HALF_OPEN);
        this._halfOpenSuccesses = 0;
        return true; // admit a trial
      }
      return false;
    }
    return true; // CLOSED or HALF_OPEN admit
  }

  /** Assert the breaker permits a call; throw {@link CircuitOpenError} if open. */
  assertPass() {
    if (!this.canPass()) throw new CircuitOpenError(`Circuit "${this.name}" is open`, { details: { name: this.name, openedForMs: this.clock() - (this._openedAt ?? this.clock()) } });
  }

  /** Record a successful call. */
  recordSuccess() {
    if (this.state === CircuitState.HALF_OPEN) {
      this._halfOpenSuccesses++;
      if (this._halfOpenSuccesses >= this.successThreshold) {
        this._failures = [];
        this._transition(CircuitState.CLOSED);
      }
    } else if (this.state === CircuitState.CLOSED) {
      this._prune();
    }
  }

  /** Record a failed call (only tripping classes advance the trip counter). */
  recordFailure(failureClass) {
    if (!CIRCUIT_TRIPPING_CLASSES.includes(failureClass)) return; // caller errors don't trip
    if (this.state === CircuitState.HALF_OPEN) {
      this._trip(); // a trial failure re-opens immediately
      return;
    }
    const now = this.clock();
    this._failures.push(now);
    this._prune();
    if (this._failures.length >= this.failureThreshold) this._trip();
  }

  /** A frozen-ish stats snapshot. */
  stats() {
    return { name: this.name, state: this.state, recentFailures: this._failures.length, trips: this._trips, openedAt: this._openedAt };
  }

  _trip() {
    this._openedAt = this.clock();
    this._trips++;
    this._transition(CircuitState.OPEN);
  }

  _prune() {
    const cutoff = this.clock() - this.rollingWindowMs;
    this._failures = this._failures.filter((t) => t >= cutoff);
  }

  _transition(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    const type = next === CircuitState.OPEN ? ReliabilityEventType.CIRCUIT_OPENED : next === CircuitState.HALF_OPEN ? ReliabilityEventType.CIRCUIT_HALF_OPEN : ReliabilityEventType.CIRCUIT_CLOSED;
    this.events?.emit(type, { name: this.name, from: prev, to: next });
  }
}

/**
 * A registry of circuit breakers keyed by name (operation kind × compartment), so each protected operation
 * has its own independent breaker. Created lazily with a shared default config.
 */
export class CircuitBreakerRegistry {
  constructor(opts = {}) {
    this.defaults = opts.defaults ?? {};
    this.events = opts.events ?? null;
    this.clock = opts.clock ?? (() => Date.now());
    this._byName = new Map();
  }

  get(name, overrides = {}) {
    let breaker = this._byName.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ name, events: this.events, clock: this.clock, ...this.defaults, ...overrides });
      this._byName.set(name, breaker);
    }
    return breaker;
  }

  stats() {
    return [...this._byName.values()].map((b) => b.stats());
  }
}

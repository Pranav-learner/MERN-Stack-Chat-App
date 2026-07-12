/**
 * @module communication-fabric/strategies/strategy
 *
 * The **Strategy interface + registry** (STEP 6). A communication strategy encapsulates one WAY of
 * fulfilling a communication — direct, relayed, offline store-and-forward, media, group fan-out,
 * synchronization, hybrid — as a self-describing, pluggable unit. The Decision Engine selects a strategy
 * THROUGH this interface (by scoring candidates), never by branching on type, so new strategies (voice,
 * video, a smarter relay) register without changing the engine.
 *
 * A strategy implements:
 *   - `type`                              its {@link StrategyType}
 *   - `supports(context) => boolean`      whether it can serve the context at all (candidacy gate)
 *   - `baseScore(context) => number`      how strong a fit it is (the engine adds rule/policy bias)
 *   - `describe(context, opts) => { primaryRoute, subsystems }`   its route + ordered subsystem list
 *   - `plan(context, decision, opts) => PlanStep[]`               the concrete, delegatable plan steps
 *
 * `BaseStrategy` supplies sensible defaults so a concrete strategy only overrides what differs.
 *
 * @security Strategies read the control-plane context + emit control-plane plan steps only. A plan step's
 * `params` carries ids + opaque refs — never bytes/keys.
 */

import { UnknownStrategyError } from "../errors.js";

let STEP_SEQ = 0;
/** Deterministic-enough step id (monotonic within a process; avoids Math.random). */
export function nextStepId(prefix = "step") {
  STEP_SEQ = (STEP_SEQ + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${STEP_SEQ}`;
}

/** Build a normalized plan step. */
export function makeStep({ subsystem, action, route, required = true, dependsOn = [], params = {} }) {
  return { stepId: nextStepId(action ?? "step"), subsystem, action, route, required, dependsOn: [...dependsOn], params: { ...params } };
}

/**
 * Base class every concrete strategy extends. Override `type` + the hooks you need.
 * @abstract
 */
export class BaseStrategy {
  /** @param {object} [opts] */
  constructor(opts = {}) {
    this.type = opts.type ?? null;
  }

  /** Candidacy gate — can this strategy serve the context at all? Default: no. */
  supports(_context) {
    return false;
  }

  /** Base fit score (the engine adds rule + policy bias on top). Default: 0. */
  baseScore(_context) {
    return 0;
  }

  /** The route + ordered subsystem list this strategy would use. Must be overridden. */
  describe(_context, _opts = {}) {
    throw new UnknownStrategyError(`Strategy ${this.type} does not implement describe()`);
  }

  /** The concrete, delegatable plan steps. Must be overridden. */
  plan(_context, _decision, _opts = {}) {
    throw new UnknownStrategyError(`Strategy ${this.type} does not implement plan()`);
  }
}

/**
 * A registry of strategies keyed by {@link StrategyType}. The Decision Engine asks it for `candidates`;
 * the execution planner asks it for the winning strategy's `plan`. Registration order is the stable
 * tie-break for equal scores, so decisions are deterministic.
 */
export class StrategyRegistry {
  constructor() {
    /** @type {Map<string, BaseStrategy>} */
    this._byType = new Map();
    /** @type {string[]} registration order */
    this._order = [];
  }

  /** Register (or replace) a strategy. @returns {this} */
  register(strategy) {
    if (!strategy || !strategy.type) throw new UnknownStrategyError("Cannot register a strategy without a type");
    if (!this._byType.has(strategy.type)) this._order.push(strategy.type);
    this._byType.set(strategy.type, strategy);
    return this;
  }

  /** Does a strategy of this type exist? */
  has(type) {
    return this._byType.has(type);
  }

  /** Get a strategy by type. @throws {UnknownStrategyError} */
  get(type) {
    const s = this._byType.get(type);
    if (!s) throw new UnknownStrategyError(`No strategy registered for type "${type}"`, { details: { type } });
    return s;
  }

  /** All registered strategy types, in registration order. */
  types() {
    return [...this._order];
  }

  /**
   * The supported candidates for a context, in registration order, each with its base score. The engine
   * layers rule + policy bias on top before selecting.
   * @returns {{ type: string, strategy: BaseStrategy, baseScore: number }[]}
   */
  candidates(context) {
    const out = [];
    for (const type of this._order) {
      const strategy = this._byType.get(type);
      let ok = false;
      try {
        ok = strategy.supports(context);
      } catch {
        ok = false;
      }
      if (ok) out.push({ type, strategy, baseScore: safeScore(strategy, context) });
    }
    return out;
  }
}

function safeScore(strategy, context) {
  try {
    const s = strategy.baseScore(context);
    return Number.isFinite(s) ? s : 0;
  } catch {
    return 0;
  }
}

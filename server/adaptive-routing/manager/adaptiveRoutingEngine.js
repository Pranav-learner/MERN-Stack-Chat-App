/**
 * @module adaptive-routing/manager/adaptiveRoutingEngine
 *
 * The **Adaptive Routing Engine** — the reusable orchestrator that turns a communication request into an
 * INTELLIGENT, explainable routing decision (STEP 12). It runs the adaptive pipeline the sprint specifies:
 *
 *   build CONTEXT (Sprint 1) → collect CAPABILITIES → analyze COMMUNICATION → analyze NETWORK →
 *   evaluate POLICIES → build CANDIDATES → SCORE routes → SELECT strategy → generate FALLBACK plan →
 *   generate EXECUTION plan (Sprint 1 planner) → EXPLAIN → persist + emit events.
 *
 * It REUSES the frozen Sprint-1 building blocks (context builder, strategy registry, execution planner,
 * decision object) and adds only the adaptive intelligence on top — no Sprint-1 redesign. Every routing
 * decision emerges from weighted scores + pluggable policies, never a hardcoded transport conditional.
 *
 * @performance The whole pipeline is pure + synchronous (no probing / I/O), so it is fast + safe under
 * concurrency. Rankings are memoized by a (capability, analysis, network, policy, weights) fingerprint;
 * capability profiles are separately cached in the capability engine.
 *
 * @security Reasons over control-plane metadata + declared capability + injected availability only. Every
 * persisted record passes a no-content deep scan first.
 *
 * @example
 * ```js
 * const engine = new AdaptiveRoutingEngine({ ...createInMemoryAdaptiveRepository() });
 * const evalResult = await engine.evaluate({ type: "direct-message", senderId: "alice", recipients: ["bob"], network: { p2p: false } }, { callerId: "alice" });
 * // evalResult.selection.strategy === "relay" (p2p down → adaptive relay wins over direct); .explanation explains why
 * ```
 */

import { ContextBuilder, createDefaultStrategyRegistry, ExecutionPlanner, createDecision, createRoute, validateRequest, validateContext, DecisionCache, PolicyDeniedError, DecisionConfidence } from "../_fabric.js";
import { CapabilityEngine } from "../capability/capabilityEngine.js";
import { CommunicationAnalyzer } from "../analyzers/communicationAnalyzer.js";
import { NetworkAnalyzer } from "../analyzers/networkAnalyzer.js";
import { CandidateBuilder } from "../routing/candidateBuilder.js";
import { RouteScoringEngine } from "../scoring/routeScoringEngine.js";
import { PolicyEvaluationEngine } from "../evaluators/policyEvaluationEngine.js";
import { StrategySelector } from "../selectors/strategySelector.js";
import { FallbackPlanner } from "../fallback/fallbackPlanner.js";
import { DecisionExplainer } from "../planners/decisionExplainer.js";
import { AdaptiveEventBus } from "../events/events.js";
import { normalizeEvaluationInput } from "../dto/dto.js";
import { validateRepository, validateConfig, validateAnalysis, validateRanking, assertAuthorized, assertNoContent } from "../validators/validators.js";
import { toEvaluationView, toCapabilityView, toRankingView, toFallbackView } from "../serializers/serializers.js";
import { AdaptiveEventType, ADAPTIVE_FRAMEWORK, ADAPTIVE_SCHEMA_VERSION, ADAPTIVE_LAYER, ADAPTIVE_SPRINT, DEFAULT_SCORE_WEIGHTS, DEFAULT_EVAL_CACHE_TTL_MS, DEFAULT_EVAL_CACHE_MAX } from "../types/types.js";

let SEQ = 0;
const seq = () => (SEQ = (SEQ + 1) % Number.MAX_SAFE_INTEGER);

export class AdaptiveRoutingEngine {
  /**
   * @param {object} deps repository bundle (`capabilities`, `evaluations`, `audit`) + optional overrides
   * @param {import("../_fabric.js").StrategyRegistry} [deps.strategyRegistry]
   * @param {AdaptiveEventBus} [deps.events] @param {object} [deps.config] `{ weights, policyConfig, cache }`
   * @param {object} [deps.providers] `{ capability, network }` service-agnostic resolvers
   * @param {object} [deps.resolvers] Sprint-1 context resolvers `{ availability, sync, security }`
   * @param {object[]} [deps.scorers] @param {object[]} [deps.policyHooks] @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    validateRepository(deps);
    this.repo = { capabilities: deps.capabilities, evaluations: deps.evaluations, audit: deps.audit };
    this.config = validateConfig(deps.config ?? {});
    this.events = deps.events ?? new AdaptiveEventBus();
    this.clock = deps.clock ?? (() => Date.now());

    this.strategyRegistry = deps.strategyRegistry ?? createDefaultStrategyRegistry();
    this.contextBuilder = new ContextBuilder({ clock: this.clock, resolveAvailability: deps.resolvers?.availability, resolveSync: deps.resolvers?.sync, resolveSecurity: deps.resolvers?.security });

    this.capabilityEngine = new CapabilityEngine({ capabilityProvider: deps.providers?.capability, events: this.events, clock: this.clock, cacheOptions: this.config.capabilityCache });
    this.communicationAnalyzer = new CommunicationAnalyzer();
    this.networkAnalyzer = new NetworkAnalyzer({ networkStateProvider: deps.providers?.network, events: this.events });
    this.candidateBuilder = new CandidateBuilder({ strategyRegistry: this.strategyRegistry });
    this.scoringEngine = new RouteScoringEngine({ scorers: deps.scorers, weights: { ...DEFAULT_SCORE_WEIGHTS, ...(this.config.weights ?? {}) }, events: this.events });
    this.policyEngine = new PolicyEvaluationEngine({ hooks: deps.policyHooks, config: this.config.policyConfig, events: this.events });
    this.selector = new StrategySelector({ events: this.events });
    this.fallbackPlanner = new FallbackPlanner({ events: this.events });
    this.explainer = new DecisionExplainer({ events: this.events });

    this.evalCache = deps.evalCache ?? new DecisionCache({ ttlMs: this.config.cache?.ttlMs ?? DEFAULT_EVAL_CACHE_TTL_MS, max: this.config.cache?.max ?? DEFAULT_EVAL_CACHE_MAX, clock: this.clock });
    this._metrics = { evaluations: 0, cacheHits: 0, denied: 0, noViable: 0 };
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === the adaptive pipeline =================================================

  /**
   * Evaluate a communication request into an intelligent routing decision.
   * @param {object} input a communication request + adaptive hints (capabilities/network/policyOverrides/weights)
   * @param {object} [opts] `{ callerId, allowServer, dryRun }`
   * @returns {Promise<object>} the evaluation view (capability + analysis + network + ranking + selection + fallback + executionPlan + explanation)
   */
  async evaluate(input, opts = {}) {
    this._metrics.evaluations++;
    const { request, senderCapabilities, receiverCapabilities, network, policyOverrides, weights } = normalizeEvaluationInput(input);
    validateRequest(request);
    if (!opts.allowServer || opts.callerId != null) assertAuthorized(request, opts.callerId, { allowServer: opts.allowServer });
    if (!request.requestId) request.requestId = `areq_${seq()}`;

    const context = this.contextBuilder.build(request);
    validateContext(context);

    // 1) capabilities
    const { negotiated } = this.capabilityEngine.collect({ senderId: request.senderId, receiverIds: request.recipients, senderDeclaration: senderCapabilities, receiverDeclarations: receiverCapabilities });

    // 2) communication analysis
    const analysis = this.communicationAnalyzer.analyze(context);
    validateAnalysis(analysis);
    this.events.emit(AdaptiveEventType.COMMUNICATION_ANALYZED, { requestId: request.requestId, communicationType: analysis.communicationType, payloadClass: analysis.payloadClass });

    // 3) network analysis
    const networkAnalysis = this.networkAnalyzer.analyze(context, { hint: network });

    // 4) policy evaluation (influences scoring; hard denial aborts)
    const policyResult = this.policyEngine.evaluate(context, analysis, policyOverrides);
    if (policyResult.denied) {
      this._metrics.denied++;
      throw new PolicyDeniedError(`Communication denied by policy "${policyResult.denied.policyId}": ${policyResult.denied.note}`, { details: policyResult.denied });
    }

    // 5) candidates → 6) score → 7) select  (cache the ranking template by input fingerprint)
    const cacheKey = this._cacheKey(negotiated, analysis, networkAnalysis, policyResult, weights);
    let ranked = this.evalCache.get(cacheKey);
    if (ranked) {
      this._metrics.cacheHits++;
    } else {
      const candidates = this.candidateBuilder.build(context, { capabilities: negotiated, network: networkAnalysis });
      ranked = this.scoringEngine.score(candidates, { context, analysis, network: networkAnalysis, capabilities: negotiated, policyResult, weights });
      validateRanking(ranked);
      this.evalCache.set(cacheKey, ranked);
    }

    const selection = this.selector.select(ranked, { requestId: request.requestId });

    // 8) fallback plan
    const fallbackPlan = this.fallbackPlanner.plan(ranked, selection, { requestId: request.requestId });

    // 9) execution plan (Sprint-1 planner, adaptive route metadata)
    const executionPlan = this._buildExecutionPlan(context, selection, ranked, policyResult);
    this.events.emit(AdaptiveEventType.EXECUTION_PLANNED, { requestId: request.requestId, planId: executionPlan.planId, strategy: selection.strategyType });

    // 10) explanation
    const explanation = this.explainer.explain({ requestId: request.requestId, analysis, network: networkAnalysis, capabilities: negotiated, ranked, selection, policyResult, fallbackPlan });

    const evaluation = { requestId: request.requestId, senderId: request.senderId, capabilities: negotiated, analysis, network: networkAnalysis, ranked, selection, fallbackPlan, executionPlan, policyResult, explanation };

    if (!opts.dryRun) await this._persist(evaluation);
    return toEvaluationView(evaluation);
  }

  /** Best route only (dry run — no persist). STEP 11 "Get Best Route". */
  async getBestRoute(input, opts = {}) {
    const view = await this.evaluate(input, { ...opts, dryRun: true });
    return { requestId: view.requestId, selection: view.selection, ranking: view.ranking };
  }

  /** Capability profile for a communication (no persist). STEP 11 "Get Capability Profile". */
  async getCapabilityProfile({ senderId, recipients = [], senderCapabilities, receiverCapabilities } = {}) {
    const { negotiated, sender, receivers } = this.capabilityEngine.collect({ senderId, receiverIds: recipients, senderDeclaration: senderCapabilities, receiverDeclarations: receiverCapabilities });
    return { negotiated: toCapabilityView(negotiated), sender: toCapabilityView(sender), receivers: receivers.map(toCapabilityView) };
  }

  /** Ranked route scores (dry run). STEP 11 "Get Route Score". */
  async getRouteScores(input, opts = {}) {
    const view = await this.evaluate(input, { ...opts, dryRun: true });
    return view.ranking;
  }

  /** Decision explanation (dry run). STEP 11 "Get Decision Explanation". */
  async getDecisionExplanation(input, opts = {}) {
    const view = await this.evaluate(input, { ...opts, dryRun: true });
    return view.explanation;
  }

  /** Fallback plan (dry run). STEP 11 "Get Fallback Plan". */
  async getFallbackPlan(input, opts = {}) {
    const view = await this.evaluate(input, { ...opts, dryRun: true });
    return view.fallbackPlan;
  }

  /** Diagnostics for a request: its stored evaluation + audit trail. STEP 11 "Communication Diagnostics". */
  async diagnostics(requestId) {
    const [evaluation, audit] = await Promise.all([this.repo.evaluations.findByRequest(requestId), this.repo.audit.listByRequest(requestId)]);
    return { requestId, evaluation: evaluation ? toEvaluationView(normalizeStored(evaluation)) : null, audit };
  }

  /** Aggregate adaptive control-plane health. STEP 11 "Fabric Health". */
  async health() {
    return {
      framework: ADAPTIVE_FRAMEWORK,
      layer: ADAPTIVE_LAYER,
      sprint: ADAPTIVE_SPRINT,
      schemaVersion: ADAPTIVE_SCHEMA_VERSION,
      status: "ok",
      strategies: this.strategyRegistry.types(),
      scoreWeights: this.scoringEngine.weights,
      policyHooks: this.policyEngine.hooks.map((h) => h.id),
      capabilityCache: this.capabilityEngine.stats(),
      evalCache: this.evalCache.stats(),
      metrics: { ...this._metrics },
      at: new Date(this.clock()).toISOString(),
    };
  }

  // === internals =============================================================

  /** Build the Sprint-1 execution plan for the selected strategy with adaptive route metadata. */
  _buildExecutionPlan(context, selection, ranked, policyResult) {
    const strategy = this.strategyRegistry.get(selection.strategyType);
    const shape = strategy.describe(context, { constraints: {} });
    const decision = createDecision({
      decisionId: `adec_${seq()}`,
      requestId: context.requestId,
      strategyType: selection.strategyType,
      primaryRoute: selection.routeKind,
      subsystems: shape.subsystems,
      confidence: selection.ambiguous ? DecisionConfidence.TENTATIVE : DecisionConfidence.LIKELY,
      reasons: (ranked.find((r) => r.strategyType === selection.strategyType) ?? {}).reasons ?? [],
      policyRefs: policyResult.policyRefs,
      constraints: policyResult.constraints ?? {},
      scoring: Object.fromEntries(ranked.map((r) => [`${r.strategyType}:${r.routeKind}`, r.total])),
      createdAt: new Date(this.clock()).toISOString(),
    });
    // an inline, per-call route planner returning the adaptive route metadata (concurrency-safe: no shared state)
    const alternatives = [...new Set(ranked.filter((r) => r.routeKind !== selection.routeKind).map((r) => r.routeKind))];
    const routePlanner = {
      planRoute: () => createRoute({ primary: selection.routeKind, candidates: alternatives, diagnostics: { adaptive: true, derivedFrom: "adaptive-scoring", scores: ranked.map((r) => ({ strategy: r.strategyType, route: r.routeKind, total: r.total, viable: r.viable })) } }),
    };
    const planner = new ExecutionPlanner({ strategyRegistry: this.strategyRegistry, routePlanner, events: null, clock: this.clock });
    return planner.plan(decision, context);
  }

  /** Persist the evaluation (capability profile + bundled evaluation + audit). Best-effort audit. */
  async _persist(evaluation) {
    assertNoContent({ analysis: evaluation.analysis, ranked: evaluation.ranked, selection: evaluation.selection, fallbackPlan: evaluation.fallbackPlan, executionPlan: evaluation.executionPlan, explanation: evaluation.explanation });
    await this.repo.capabilities.upsert(evaluation.capabilities);
    await this.repo.evaluations.create({
      requestId: evaluation.requestId,
      senderId: evaluation.senderId,
      analysis: evaluation.analysis,
      network: evaluation.network,
      capabilityFingerprint: evaluation.capabilities.fingerprint,
      ranked: evaluation.ranked,
      selection: evaluation.selection,
      fallbackPlan: evaluation.fallbackPlan,
      executionPlan: evaluation.executionPlan,
      policyRefs: evaluation.policyResult.policyRefs,
      explanation: evaluation.explanation,
      schemaVersion: ADAPTIVE_SCHEMA_VERSION,
      createdAt: new Date(this.clock()).toISOString(),
    });
    await this._audit(evaluation.requestId, AdaptiveEventType.STRATEGY_SELECTED, { strategy: evaluation.selection.strategyType, route: evaluation.selection.routeKind });
  }

  async _audit(requestId, event, detail = {}) {
    try {
      await this.repo.audit.append({ requestId, event, at: new Date(this.clock()).toISOString(), ...detail });
    } catch {
      /* best-effort */
    }
  }

  _cacheKey(capabilities, analysis, network, policyResult, weights) {
    return JSON.stringify({
      c: capabilities.fingerprint,
      a: { t: analysis.communicationType, cv: analysis.conversationType, m: analysis.mediaType, pc: analysis.payloadClass, pr: analysis.priority, s: analysis.syncState, av: analysis.availability, g: analysis.isGroup },
      n: network.availability,
      p: { refs: policyResult.policyRefs, vr: policyResult.vetoRoutes, vs: policyResult.vetoStrategies, b: policyResult.bias, w: policyResult.weights },
      w: weights ?? null,
    });
  }
}

/** Coerce a stored evaluation record back into the shape `toEvaluationView` expects. */
function normalizeStored(record) {
  return {
    requestId: record.requestId,
    capabilities: { transports: [], features: [], ...(record.capability ?? {}), fingerprint: record.capabilityFingerprint },
    analysis: record.analysis,
    network: record.network,
    ranked: record.ranked,
    selection: record.selection,
    fallbackPlan: record.fallbackPlan,
    executionPlan: record.executionPlan,
    explanation: record.explanation,
    policyResult: { policyRefs: record.policyRefs ?? [] },
  };
}

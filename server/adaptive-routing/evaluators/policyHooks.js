/**
 * @module adaptive-routing/evaluators/policyHooks
 *
 * **Adaptive policy hooks** (STEP 9) — pluggable rules that INFLUENCE SCORING rather than merely allow/deny.
 * Each hook reads the context + communication analysis + config and returns bias (per strategy), route /
 * strategy vetoes, and/or scoring-weight overrides. These are the seams the sprint calls out — data-saver,
 * battery-saver, and enterprise policy hooks — plus a couple of built-ins. A hook NEVER executes anything;
 * it shapes the route scores so the optimal strategy emerges adaptively.
 *
 * A hook: `{ id, kind, describe, evaluate(context, analysis, config) => { bias?, vetoRoutes?, vetoStrategies?, weights?, note?, deny? } }`.
 *
 * @security Hooks read control-plane analysis + config only. No content.
 */

import { PolicyKind } from "../../communication-fabric/index.js";
import { StrategyType, RouteKind, ScoreDimension, PayloadClass } from "../types/types.js";

/**
 * **Data-saver hook** — when enabled, penalise expensive/eager paths for large payloads: veto the relayed
 * transport (extra hop), bias toward store-and-forward batching, and up-weight COST so cost dominates.
 */
export const dataSaverHook = {
  id: "hook.data-saver",
  kind: PolicyKind.MEDIA,
  describe: "Data-saver: prefer cheap/batched routes; avoid relayed transport for large payloads.",
  evaluate(_context, analysis, config = {}) {
    if (!config.dataSaver?.enabled) return {};
    const out = { bias: { [StrategyType.OFFLINE]: 1 }, weights: { [ScoreDimension.COST]: 4 }, note: "data-saver active" };
    if (analysis.payloadClass === PayloadClass.LARGE) out.vetoRoutes = [RouteKind.RELAYED_TRANSPORT];
    return out;
  },
};

/**
 * **Battery-saver hook** — when enabled, prefer batched store-and-forward (radio coalescing) over eager
 * direct p2p, and up-weight cost. Non-urgent only; urgent traffic ignores battery saving.
 */
export const batterySaverHook = {
  id: "hook.battery-saver",
  kind: PolicyKind.PRIORITY,
  describe: "Battery-saver: prefer batched delivery over eager p2p for non-urgent traffic.",
  evaluate(_context, analysis, config = {}) {
    if (!config.batterySaver?.enabled) return {};
    if (analysis.priority === "urgent") return { note: "battery-saver bypassed for urgent" };
    return { bias: { [StrategyType.OFFLINE]: 1, [StrategyType.DIRECT]: -1 }, weights: { [ScoreDimension.COST]: 3 }, note: "battery-saver active" };
  },
};

/**
 * **Enterprise hook** — organisational routing controls. `forceRelay` routes all messaging through the
 * corporate relay (veto direct); `blockP2P` forbids peer-to-peer (veto direct transport); `blockOffline`
 * forbids store-and-forward for compliance.
 */
export const enterpriseHook = {
  id: "hook.enterprise",
  kind: PolicyKind.ENTERPRISE,
  describe: "Enterprise routing controls (force-relay / block-p2p / block-offline).",
  evaluate(_context, _analysis, config = {}) {
    const ent = config.enterprise;
    if (!ent) return {};
    const vetoRoutes = [];
    if (ent.blockP2P || ent.forceRelay) vetoRoutes.push(RouteKind.DIRECT_TRANSPORT);
    if (ent.blockOffline) vetoRoutes.push(RouteKind.STORE_AND_FORWARD);
    const bias = ent.forceRelay ? { [StrategyType.RELAY]: 3 } : {};
    return { vetoRoutes, bias, note: vetoRoutes.length ? `enterprise controls: ${vetoRoutes.join(",")}` : "enterprise policy present" };
  },
};

/**
 * **Security hook** — when a deployment requires direct-only security posture (`directOnly`), veto relayed
 * transport; when it requires a ready secure session, deny if the context reports it is not ready.
 */
export const securityHook = {
  id: "hook.security",
  kind: PolicyKind.SECURITY,
  describe: "Security posture controls (direct-only / require-secure-session).",
  evaluate(context, _analysis, config = {}) {
    const sec = config.security ?? {};
    const out = {};
    if (sec.directOnly) out.vetoRoutes = [RouteKind.RELAYED_TRANSPORT];
    if (sec.requireSecureSession && context.raw?.security?.sessionReady === false) return { deny: true, note: "secure session not ready" };
    if (out.vetoRoutes) out.note = "direct-only security posture";
    return out;
  },
};

/** The default, ordered adaptive hook set. A deployment adds/removes hooks freely. */
export const DEFAULT_POLICY_HOOKS = Object.freeze([dataSaverHook, batterySaverHook, enterpriseHook, securityHook]);

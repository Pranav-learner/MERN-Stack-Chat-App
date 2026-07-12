/**
 * @module communication-fabric/policies/policy
 *
 * The **Policy interface + PolicySet** (STEP 8). A policy is a configurable, pluggable rule that
 * constrains or biases how a communication may occur — messaging, media, group, synchronization,
 * security, and priority policies all share this one shape. Policies are DECLARATIVE and CONFIGURABLE: a
 * deployment supplies a config bag, and each policy reads its slice, so behaviour changes without code
 * changes.
 *
 * A policy implements:
 *   - `id`, `kind`                        identity + {@link PolicyKind}
 *   - `applies(context, config) => bool`  whether it participates for this context
 *   - `evaluate(context, config) => { bias?, constraints?, deny?, note? }`
 *
 * A policy NEVER executes communication; it only shapes the decision (bias/constraints) or vetoes it
 * (`deny`). The {@link PolicyEngine} folds all applicable policy outputs together.
 *
 * @security Policies read control-plane context + config only. No content.
 */

/** The policy families this sprint models. @readonly @enum {string} */
export const PolicyKind = Object.freeze({
  MESSAGING: "messaging",
  MEDIA: "media",
  GROUP: "group",
  SYNCHRONIZATION: "synchronization",
  SECURITY: "security",
  PRIORITY: "priority",
  ENTERPRISE: "enterprise", // FUTURE — extension seam for org policies
});

export const ALL_POLICY_KINDS = Object.freeze(Object.values(PolicyKind));

/**
 * A named, ordered collection of policies. The engine holds one PolicySet; a deployment builds it from
 * the defaults plus its own additions/overrides.
 */
export class PolicySet {
  constructor() {
    /** @type {Map<string, object>} */
    this._byId = new Map();
    this._order = [];
  }

  /** Add (or replace) a policy. @returns {this} */
  add(policy) {
    if (!policy || !policy.id) throw new Error("A policy requires an id");
    if (!this._byId.has(policy.id)) this._order.push(policy.id);
    this._byId.set(policy.id, policy);
    return this;
  }

  /** Remove a policy by id. */
  remove(id) {
    if (this._byId.delete(id)) this._order = this._order.filter((x) => x !== id);
    return this;
  }

  has(id) {
    return this._byId.has(id);
  }

  get(id) {
    return this._byId.get(id) ?? null;
  }

  /** All policies in order. */
  all() {
    return this._order.map((id) => this._byId.get(id));
  }

  /** Policies of a given kind. */
  ofKind(kind) {
    return this.all().filter((p) => p.kind === kind);
  }

  ids() {
    return [...this._order];
  }
}

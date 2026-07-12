/**
 * @module fabric-reliability/retry/failureClassifier
 *
 * **Failure classification** (STEP 5) — maps any thrown error to a {@link FailureClass}, which drives every
 * downstream reliability decision: whether to retry, whether to trip the circuit, and whether to attempt
 * recovery. It reads a fabric-typed error's own `failureClass`/`reason`/`code` when present (the frozen
 * lower layers already classify their errors), and falls back to structural heuristics (timeouts, resource
 * exhaustion, validation/authorization codes) otherwise. The classifier is pluggable — a deployment can
 * register additional rules without touching the retry/circuit machinery.
 *
 * @security Reads error metadata only. No content.
 */

import { FailureClass } from "../types/types.js";

/** Default, ordered classification rules (`(error) => FailureClass | null`). First match wins. */
export const DEFAULT_CLASSIFICATION_RULES = Object.freeze([
  // 1) a fabric-typed error that already declares its class
  (e) => (e && typeof e.failureClass === "string" ? e.failureClass : null),
  // 2) authorization
  (e) => (matches(e, ["UNAUTHORIZED", "FORBIDDEN", "AUTH"]) || e?.status === 401 || e?.status === 403 ? FailureClass.AUTHORIZATION : null),
  // 3) validation / bad input
  (e) => (matches(e, ["VALIDATION", "INVALID", "MALFORMED", "CONTENT_LEAK"]) || e?.status === 400 || e?.status === 422 ? FailureClass.VALIDATION : null),
  // 4) timeout
  (e) => (matches(e, ["TIMEOUT", "ETIMEDOUT", "DEADLINE"]) || e?.status === 504 ? FailureClass.TIMEOUT : null),
  // 5) resource / backpressure
  (e) => (matches(e, ["RESOURCE", "BULKHEAD", "CIRCUIT", "RATE", "OVERFLOW", "UNAVAILABLE", "ECONNREFUSED", "ECONNRESET"]) || e?.status === 429 || e?.status === 503 ? FailureClass.RESOURCE : null),
  // 6) explicitly permanent
  (e) => (matches(e, ["PERMANENT", "NOT_FOUND"]) || e?.status === 404 ? FailureClass.PERMANENT : null),
  // 7) transient (network-ish / 5xx)
  (e) => (matches(e, ["TRANSIENT", "TEMPORARY", "AGAIN"]) || (e?.status >= 500 && e?.status < 600) ? FailureClass.TRANSIENT : null),
]);

export class FailureClassifier {
  /** @param {object} [opts] `{ rules }` ordered classification rules */
  constructor(opts = {}) {
    this.rules = opts.rules ?? DEFAULT_CLASSIFICATION_RULES;
  }

  /** Prepend a custom rule (highest precedence). */
  addRule(rule) {
    this.rules = [rule, ...this.rules];
    return this;
  }

  /** Classify an error. Unmatched → {@link FailureClass.UNKNOWN} (treated as a one-shot retry). */
  classify(error) {
    for (const rule of this.rules) {
      let cls = null;
      try {
        cls = rule(error);
      } catch {
        cls = null;
      }
      if (cls && Object.values(FailureClass).includes(cls)) return cls;
    }
    return FailureClass.UNKNOWN;
  }
}

function matches(error, needles) {
  const hay = `${error?.code ?? ""} ${error?.reason ?? ""} ${error?.name ?? ""} ${error?.message ?? ""}`.toUpperCase();
  return needles.some((n) => hay.includes(n));
}

/**
 * @module fabric-reliability/timeout/timeout
 *
 * **Timeout policies** (STEP 5) — bound how long a fabric operation may run before it is abandoned with an
 * {@link OperationTimeoutError}. `withTimeout` races a promise against a deadline; `TimeoutPolicy` resolves
 * a per-operation-kind timeout (with an overridable default). Timeouts are cooperative — they reject the
 * caller's await, and the underlying operation is expected to be side-effect-safe to abandon (fabric
 * operations are control-plane + checkpointed, so an abandoned attempt is recoverable).
 *
 * @security Reasons over durations only. No content.
 */

import { DEFAULT_TIMEOUT_MS } from "../types/types.js";
import { OperationTimeoutError } from "../errors.js";

/**
 * Race a promise (or thunk) against a millisecond deadline. Rejects with {@link OperationTimeoutError} if
 * the deadline wins. The timer is `unref`'d so it never keeps the process alive. `timeoutMs <= 0` disables
 * the timeout (runs unbounded).
 * @param {Promise<any>|(() => Promise<any>)} work @param {number} timeoutMs @param {object} [opts] `{ label, onTimeout }`
 * @returns {Promise<any>}
 */
export function withTimeout(work, timeoutMs, opts = {}) {
  const promise = typeof work === "function" ? Promise.resolve().then(work) : Promise.resolve(work);
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        opts.onTimeout?.();
      } catch {
        /* ignore */
      }
      reject(new OperationTimeoutError(`Operation "${opts.label ?? "?"}" exceeded ${timeoutMs}ms`, { details: { label: opts.label, timeoutMs } }));
    }, timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * A per-operation-kind timeout policy. A deployment supplies overrides; unknown kinds fall back to the
 * default. Configurable + extensible (STEP 5 "must be configurable").
 */
export class TimeoutPolicy {
  /** @param {object} [opts] `{ defaultMs, perKind: { [kind]: ms } }` */
  constructor(opts = {}) {
    this.defaultMs = opts.defaultMs ?? DEFAULT_TIMEOUT_MS;
    this.perKind = { ...(opts.perKind ?? {}) };
  }

  /** The timeout (ms) for an operation kind. */
  forKind(kind) {
    return this.perKind[kind] ?? this.defaultMs;
  }

  /** Set / override a kind's timeout at runtime. */
  set(kind, ms) {
    this.perKind[kind] = ms;
    return this;
  }
}

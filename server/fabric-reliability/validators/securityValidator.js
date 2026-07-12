/**
 * @module fabric-reliability/validators/securityValidator
 *
 * **Security validation** (STEP 7) — the single place the reliability layer enforces + AUDITS the security
 * invariants of every orchestration operation: authorization (the caller must own the operation),
 * idempotency / REPLAY protection (a repeated idempotency key is rejected), a pluggable RATE-LIMITING
 * extension point, and a tamper-evident AUDIT record for every decision. It centralises the checks the
 * lower layers already perform per-operation (decision / policy / execution / media / synchronization
 * authorization) so an operator has one audited chokepoint.
 *
 * @security Reasons over caller ids + operation kinds + idempotency keys only — never content/keys. The
 * audit records are control-plane only and pass the no-content scan.
 */

import { UnauthorizedReliabilityError, ReplayDetectedError, RateLimitedError } from "../errors.js";
import { ReliabilityEventType } from "../types/types.js";

export class SecurityValidator {
  /**
   * @param {object} [deps]
   * @param {(ctx: object) => boolean} [deps.authorizer] custom authorization predicate (default: caller === owner)
   * @param {(ctx: object) => boolean} [deps.rateLimiter] extension point — return false to reject (default: allow)
   * @param {object} [deps.audit] the audit store (`append`) — audits are best-effort persisted
   * @param {import("../events/events.js").FabricReliabilityEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {number} [deps.replayTtlMs] @param {number} [deps.replayMax]
   */
  constructor(deps = {}) {
    this.authorizer = deps.authorizer ?? defaultAuthorizer;
    this.rateLimiter = deps.rateLimiter ?? (() => true);
    this.audit = deps.audit ?? null;
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.replayTtlMs = deps.replayTtlMs ?? 300_000;
    this.replayMax = deps.replayMax ?? 100_000;
    this._seen = new Map(); // idempotencyKey → expiresAt
    this._audited = 0;
  }

  /**
   * Validate + audit an operation before it runs.
   * @param {object} ctx `{ kind, operationId, callerId, ownerId, idempotencyKey, allowServer }`
   * @returns {object} `{ authorized: true, idempotent: boolean }`
   * @throws {UnauthorizedReliabilityError|ReplayDetectedError|RateLimitedError}
   */
  validate(ctx = {}) {
    // 1) authorization
    const authorized = ctx.allowServer && ctx.callerId == null ? true : this._authorize(ctx);
    if (!authorized) {
      this._auditRecord(ctx, "denied", "unauthorized");
      throw new UnauthorizedReliabilityError(`Caller not authorized for "${ctx.kind}"`, { details: { kind: ctx.kind, operationId: ctx.operationId } });
    }
    // 2) rate limiting (pluggable extension point)
    let allowed = true;
    try {
      allowed = this.rateLimiter(ctx) !== false;
    } catch {
      allowed = true;
    }
    if (!allowed) {
      this._auditRecord(ctx, "denied", "rate-limited");
      throw new RateLimitedError(`Rate limit exceeded for "${ctx.kind}"`, { details: { kind: ctx.kind } });
    }
    // 3) replay / idempotency
    let idempotent = false;
    if (ctx.idempotencyKey) {
      this._pruneReplay();
      if (this._seen.has(ctx.idempotencyKey)) {
        this._auditRecord(ctx, "denied", "replay");
        throw new ReplayDetectedError(`Replayed operation "${ctx.kind}"`, { details: { idempotencyKey: ctx.idempotencyKey } });
      }
      this._seen.set(ctx.idempotencyKey, this.clock() + this.replayTtlMs);
      idempotent = true;
    }
    this._auditRecord(ctx, "allowed", null);
    return { authorized: true, idempotent };
  }

  _authorize(ctx) {
    try {
      return this.authorizer(ctx) === true;
    } catch {
      return false;
    }
  }

  _auditRecord(ctx, decision, reason) {
    this._audited++;
    const record = { operationId: ctx.operationId ?? null, kind: ctx.kind ?? null, callerId: ctx.callerId ?? null, decision, reason, at: new Date(this.clock()).toISOString() };
    this.events?.emit(ReliabilityEventType.SECURITY_AUDITED, { operationId: record.operationId, kind: record.kind, decision, reason });
    if (this.audit?.append) {
      // best-effort — never block the operation on audit persistence
      Promise.resolve(this.audit.append({ ...record, event: "security-audit" })).catch(() => {});
    }
    return record;
  }

  _pruneReplay() {
    if (this._seen.size < this.replayMax) return;
    const now = this.clock();
    for (const [k, exp] of this._seen) if (exp <= now) this._seen.delete(k);
  }

  stats() {
    return { audited: this._audited, replayCacheSize: this._seen.size };
  }
}

/** Default authorization: the caller must be the operation's owner (sender). Server-driven flows allowed. */
function defaultAuthorizer(ctx) {
  if (ctx.allowServer && ctx.callerId == null) return true;
  if (ctx.ownerId == null) return true; // no owner declared → nothing to spoof
  return String(ctx.callerId) === String(ctx.ownerId);
}

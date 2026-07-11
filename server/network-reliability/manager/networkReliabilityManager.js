/**
 * @module network-reliability/manager
 *
 * The **Network Reliability Manager** — the reusable facade for Layer 7, Sprint 3. It makes the
 * ACTIVE CONNECTIONS produced by Sprint 2 reliable: it registers + tracks them, monitors their
 * health via heartbeats, and drives automatic, session-preserving RECOVERY when they drop, degrade,
 * or the network changes — with configurable retry policies, observability, and alerting.
 *
 * @important It does NOT establish connections and does NOT carry application data (no P2P messaging,
 * data channels, media, or file transfer — that is Layer 8). It manages connection *records* +
 * reacts to their lifecycle via INJECTED recovery hooks, so it is transport-independent.
 *
 * @security Connection records are CONTROL-PLANE metadata only (ids, states, latencies, the crypto
 * `sessionId` — an id, not a key). Recovery PRESERVES the session by keeping `sessionId` stable
 * across a reconnect; the manager never touches key bytes.
 *
 * @example
 * ```js
 * const mgr = new NetworkReliabilityManager({ ...createInMemoryReliabilityRepository(), recoveryHooks: { reconnect } });
 * const conn = await mgr.registerConnection({ deviceId: "d1", peerId: "d2", sessionId: "s1", state: "connected" });
 * await mgr.recordHeartbeat(conn.connectionId, { latencyMs: 30 });
 * await mgr.recover(conn.connectionId, "unexpected-disconnect");
 * ```
 */

import crypto from "node:crypto";
import {
  ConnectionState,
  RecoveryTrigger,
  RecoveryAction,
  ReliabilityEventType,
  ReliabilityFailureReason,
  HealthStatus,
  TransportKind,
  Metric,
  RECOVERY_PLANS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  NETREL_SCHEMA_VERSION,
  isLiveConnectionState,
} from "../types/types.js";
import { assertTransition } from "./connectionLifecycle.js";
import { healthForConnection } from "../health/healthMonitor.js";
import { buildDiagnostics } from "../diagnostics/diagnostics.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { ReliabilityMetrics } from "../observability/metrics.js";
import { ReliabilityEventBus } from "../events/events.js";
import {
  validateRegisterRequest,
  validateConnectionId,
  validateRef,
  validateTrigger,
  requireConnection,
  assertOwner,
  assertNoSecretMaterial,
  validateRepository,
} from "../validators/validators.js";

export class NetworkReliabilityManager {
  /**
   * @param {object} deps
   * @param {object} deps.connections connection repository (required)
   * @param {object} [deps.recovery] recovery-history repository @param {object} [deps.alerts] alert store
   * @param {ReliabilityEventBus} [deps.events] @param {ReliabilityMetrics} [deps.metrics]
   * @param {object} [deps.monitor] a ReliabilityMonitor @param {RecoveryCoordinator} [deps.recoveryCoordinator]
   * @param {object} [deps.recoveryHooks] recovery hooks (if no coordinator supplied)
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {number} [deps.heartbeatTimeoutMs] @param {object} [deps.retryPolicy] @param {(ms:number)=>Promise<void>} [deps.sleep]
   */
  constructor(deps) {
    if (!deps || !deps.connections) throw new Error("NetworkReliabilityManager requires { connections }");
    this.connections = validateRepository(deps.connections);
    this.recoveryRepo = deps.recovery ?? null;
    this.events = deps.events ?? new ReliabilityEventBus();
    this.metrics = deps.metrics ?? new ReliabilityMetrics();
    this.monitor = deps.monitor ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.retryPolicy = deps.retryPolicy;
    this.recovery =
      deps.recoveryCoordinator ??
      new RecoveryCoordinator({ hooks: deps.recoveryHooks, events: this.events, metrics: this.metrics, retryPolicy: this.retryPolicy, clock: this.clock, sleep: deps.sleep });
  }

  // === registration + lifecycle ===========================================

  /**
   * Register an active connection to monitor. @returns {Promise<object>} public connection DTO.
   * @param {{ deviceId: string, peerId: string, sessionId?: string, planId?: string, transport?: string,
   *   relayUsed?: boolean, selectedPair?: object, state?: string, retryPolicy?: object, metadata?: object }} request
   */
  async registerConnection(request) {
    validateRegisterRequest(request);
    const at = this._nowIso();
    const state = request.state ?? ConnectionState.CONNECTED;
    const record = {
      connectionId: request.connectionId ?? this.idGenerator(),
      deviceId: String(request.deviceId),
      peerId: String(request.peerId),
      sessionId: request.sessionId ?? null,
      planId: request.planId ?? null,
      state,
      transport: request.transport ?? TransportKind.UNKNOWN,
      relayUsed: !!request.relayUsed,
      selectedPair: request.selectedPair ?? null,
      reconnectCount: 0,
      recoveryCount: 0,
      retryPolicy: request.retryPolicy ?? {},
      metadata: request.metadata ?? {},
      establishedAt: at,
      lastActivityAt: at,
      heartbeatExpiresAt: this._heartbeatExpiry(at),
      version: 1,
      schemaVersion: NETREL_SCHEMA_VERSION,
    };
    record.health = healthForConnection(record, this.clock(), this.heartbeatTimeoutMs);
    assertNoSecretMaterial(record, "connection");
    const stored = await this.connections.create(record);
    this.metrics.recordConnection(isLiveConnectionState(stored.state));
    if (stored.relayUsed) this.metrics.increment(Metric.RELAY_USAGE);
    this.events.emit(ReliabilityEventType.CONNECTION_REGISTERED, this._eventFor(stored));
    return toPublicConnection(stored);
  }

  /** Explicitly transition a connection's state (owner-scoped optionally). */
  async setState(connectionId, toState, options = {}) {
    const conn = await this._require(connectionId);
    if (options.actingDevice) assertOwner(conn, options.actingUser, options.actingDevice);
    return toPublicConnection(await this._transition(conn, toState, { reason: options.reason }));
  }

  /**
   * Record a heartbeat: refresh liveness + measure latency + recompute health. A heartbeat on a
   * dropped connection recovers it to CONNECTED. @returns {Promise<object>} public DTO.
   * @param {string} connectionId @param {{ latencyMs?: number, actingDevice?: string }} [options]
   */
  async recordHeartbeat(connectionId, options = {}) {
    const conn = await this._require(connectionId);
    if (options.actingDevice) assertOwner(conn, options.actingUser, options.actingDevice);
    const at = this._nowIso();
    this.metrics.increment(Metric.HEARTBEAT_TOTAL);
    if (Number.isFinite(options.latencyMs)) this.metrics.observe(Metric.LATENCY, options.latencyMs);

    const patch = {
      lastActivityAt: at,
      heartbeatExpiresAt: this._heartbeatExpiry(at),
      health: { ...(conn.health ?? {}), latencyMs: options.latencyMs ?? conn.health?.latencyMs ?? null, missedHeartbeats: 0, lastHeartbeatAt: at },
    };
    // A heartbeat on a non-live connection recovers it.
    const recovering = !isLiveConnectionState(conn.state) && conn.state !== ConnectionState.CLOSED && conn.state !== ConnectionState.FAILED;
    const nextState = recovering ? ConnectionState.CONNECTED : (conn.state === ConnectionState.CONNECTING ? ConnectionState.CONNECTED : conn.state);
    const updated = await this._transition({ ...conn }, nextState, { reason: "heartbeat", patch, silent: nextState === conn.state });
    const withHealth = await this._refreshHealth(updated);
    this.events.emit(ReliabilityEventType.HEARTBEAT_RECEIVED, this._eventFor(withHealth, { latencyMs: options.latencyMs }));
    return toPublicConnection(withHealth);
  }

  /** Record generic activity (keeps a connection alive without a full heartbeat). */
  async recordActivity(connectionId) {
    const conn = await this._require(connectionId);
    const at = this._nowIso();
    return toPublicConnection(await this.connections.update(connectionId, { lastActivityAt: at, heartbeatExpiresAt: this._heartbeatExpiry(at) }));
  }

  // === recovery ============================================================

  /**
   * Recover a connection from a trigger (session-preserving). Drives the state machine + the recovery
   * coordinator + retry policy. @returns {Promise<{ connection: object, recovery: object }>}
   * @param {string} connectionId @param {string} trigger one of {@link RecoveryTrigger}
   * @param {{ actingDevice?: string, retryPolicy?: object }} [options]
   */
  async recover(connectionId, trigger, options = {}) {
    let conn = await this._require(connectionId);
    if (options.actingDevice) assertOwner(conn, options.actingUser, options.actingDevice);
    validateTrigger(trigger);
    const plan = RECOVERY_PLANS[trigger] ?? { action: RecoveryAction.RECONNECT };

    // Drive into a recovering state (through DISCONNECTED if currently live).
    if (isLiveConnectionState(conn.state)) conn = await this._transition(conn, ConnectionState.DISCONNECTED, { reason: trigger });
    const recoverState = plan.action === RecoveryAction.RECONNECT || plan.action === RecoveryAction.RESUME_SESSION ? ConnectionState.RECONNECTING : ConnectionState.RECOVERING;
    if (conn.state !== recoverState) conn = await this._transition(conn, recoverState, { reason: trigger });

    if (trigger === RecoveryTrigger.NAT_REBIND) this.monitor?.onNatRebind({ deviceId: conn.deviceId, connectionId });

    const ctx = { connectionId: conn.connectionId, sessionId: conn.sessionId, deviceId: conn.deviceId, peerId: conn.peerId, planId: conn.planId, trigger };
    const result = await this.recovery.recover(trigger, ctx, { retryPolicy: options.retryPolicy ?? conn.retryPolicy });

    if (result.recovered) {
      const at = this._nowIso();
      conn = await this._transition(conn, ConnectionState.CONNECTED, {
        reason: "recovered",
        patch: {
          reconnectCount: (conn.reconnectCount ?? 0) + result.attempts,
          recoveryCount: (conn.recoveryCount ?? 0) + 1,
          lastActivityAt: at,
          heartbeatExpiresAt: this._heartbeatExpiry(at),
          health: { ...(conn.health ?? {}), missedHeartbeats: 0, lastHeartbeatAt: at },
        },
      });
      conn = await this._refreshHealth(conn);
      this.metrics.recordRecovery(true, result.elapsedMs);
      if (result.attempts > 0) this.metrics.increment(Metric.RECONNECT_TOTAL, result.attempts);
    } else {
      conn = await this._transition(conn, ConnectionState.FAILED, {
        reason: result.reason ?? ReliabilityFailureReason.RECOVERY_EXHAUSTED,
        patch: { recoveryCount: (conn.recoveryCount ?? 0) + 1 },
      });
      this.metrics.recordRecovery(false, result.elapsedMs);
      this.monitor?.onRecoveryFailure({ connectionId });
    }
    await this._recordRecovery(conn, trigger, result);
    return { connection: toPublicConnection(conn), recovery: result };
  }

  /** A manual reconnect (owner-initiated). Uses the `UNEXPECTED_DISCONNECT` recovery path. */
  async reconnect(connectionId, options = {}) {
    return this.recover(connectionId, RecoveryTrigger.UNEXPECTED_DISCONNECT, options);
  }

  /** A device reports a network event (WiFi↔mobile, NAT rebind) → triggers recovery. */
  async reportNetworkEvent(connectionId, trigger, options = {}) {
    return this.recover(connectionId, trigger, options);
  }

  /** Mark a connection disconnected (transport dropped) without recovering yet. */
  async markDisconnected(connectionId, options = {}) {
    const conn = await this._require(connectionId);
    return toPublicConnection(await this._transition(conn, ConnectionState.DISCONNECTED, { reason: options.reason ?? "disconnected" }));
  }

  /** Close a connection cleanly (terminal). */
  async closeConnection(connectionId, options = {}) {
    const conn = await this._require(connectionId);
    if (options.actingDevice) assertOwner(conn, options.actingUser, options.actingDevice);
    const closed = await this._transition(conn, ConnectionState.CLOSED, { reason: options.reason ?? "closed" });
    this.events.emit(ReliabilityEventType.CONNECTION_CLOSED, this._eventFor(closed));
    return toPublicConnection(closed);
  }

  // === heartbeat sweep =====================================================

  /**
   * Sweep timed-out connections → recover them (heartbeat failure detection). Emits HEARTBEAT_MISSED.
   * @param {number} [now] @returns {Promise<{ timedOut: number, recovered: number }>}
   */
  async sweepHeartbeats(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const stale = await this.connections.listTimedOut(nowIso);
    let recovered = 0;
    for (const conn of stale) {
      try {
        this.metrics.increment(Metric.HEARTBEAT_MISSED);
        // bump missed-heartbeat counter for health, then recover.
        await this.connections.update(conn.connectionId, { health: { ...(conn.health ?? {}), missedHeartbeats: (conn.health?.missedHeartbeats ?? 0) + 1 } });
        this.events.emit(ReliabilityEventType.HEARTBEAT_MISSED, this._eventFor(conn));
        this.monitor?.onHeartbeatTimeout({ connectionId: conn.connectionId });
        const out = await this.recover(conn.connectionId, RecoveryTrigger.CONNECTION_TIMEOUT);
        if (out.recovery.recovered) recovered++;
      } catch {
        // concurrent transition / already closed; skip
      }
    }
    return { timedOut: stale.length, recovered };
  }

  // === queries =============================================================

  /** A connection's public DTO. */
  async getConnection(connectionId, options = {}) {
    const conn = await this._require(connectionId);
    if (options.actingDevice) assertOwner(conn, options.actingUser, options.actingDevice);
    return toPublicConnection(await this._refreshHealth(conn));
  }

  /** A connection's current health (recomputed). */
  async getHealth(connectionId) {
    const conn = await this._require(connectionId);
    return healthForConnection(conn, this.clock(), this.heartbeatTimeoutMs);
  }

  /** A connection's diagnostics (+ recovery history). */
  async getDiagnostics(connectionId, options = {}) {
    const conn = await this._require(connectionId);
    const recoveryHistory = this.recoveryRepo ? await this.recoveryRepo.listByConnection(connectionId, { limit: options.limit ?? 20 }) : [];
    return buildDiagnostics({ ...conn, health: healthForConnection(conn, this.clock(), this.heartbeatTimeoutMs) }, { recoveryHistory, now: this.clock() });
  }

  /** A device's connections. */
  async listConnections(deviceId, options = {}) {
    validateRef(deviceId, "device identifier");
    return (await this.connections.listByDevice(String(deviceId), { limit: options.limit })).map(toPublicConnection);
  }

  /** Recovery history for a connection. */
  async getRecoveryHistory(connectionId, options = {}) {
    validateConnectionId(connectionId);
    if (!this.recoveryRepo) return [];
    return this.recoveryRepo.listByConnection(String(connectionId), { limit: options.limit });
  }

  /** Counts of connections by state. */
  async countByState() {
    return this.connections.countByState();
  }

  /** Metrics snapshot. */
  metricsSnapshot() {
    return this.metrics.snapshot();
  }

  // === internals ==========================================================

  /** @private Load + require a connection (validated). */
  async _require(connectionId) {
    validateConnectionId(connectionId);
    return requireConnection(await this.connections.findById(connectionId), connectionId);
  }

  /** @private Guarded state transition + persist + emit. */
  async _transition(conn, toState, options = {}) {
    if (toState === conn.state && options.silent) {
      // idempotent refresh without a state change — still persist the patch.
      if (options.patch) return this.connections.update(conn.connectionId, { ...options.patch });
      return conn;
    }
    assertTransition(conn.state, toState);
    const at = this._nowIso();
    const patch = { state: toState, version: (conn.version ?? 0) + 1, updatedAt: at, ...(options.patch ?? {}) };
    if (patch.health) assertNoSecretMaterial(patch, "connection");
    const updated = await this.connections.update(conn.connectionId, patch);
    this.events.emit(ReliabilityEventType.CONNECTION_STATE_CHANGED, this._eventFor(updated, { previousState: conn.state, reason: options.reason }));
    this.metrics.gauge(Metric.ACTIVE_CONNECTIONS, undefined); // touched lazily; real value from countByState
    return updated;
  }

  /** @private Recompute + persist health; emit HEALTH_CHANGED on a status change. */
  async _refreshHealth(conn) {
    const health = healthForConnection(conn, this.clock(), this.heartbeatTimeoutMs);
    const prevStatus = conn.health?.status;
    const updated = await this.connections.update(conn.connectionId, { health });
    this.metrics.gauge(Metric.HEALTH_SCORE, health.score, { connection: "aggregate" });
    if (health.status !== prevStatus) {
      this.events.emit(ReliabilityEventType.HEALTH_CHANGED, this._eventFor(updated, { status: health.status, score: health.score }));
      if (health.status === HealthStatus.UNHEALTHY) this.monitor?.onUnhealthyConnection({ connectionId: conn.connectionId });
    }
    return updated;
  }

  /** @private Append a recovery-history record. */
  async _recordRecovery(conn, trigger, result) {
    if (!this.recoveryRepo) return;
    try {
      await this.recoveryRepo.record({
        recoveryId: this.idGenerator(),
        connectionId: conn.connectionId,
        deviceId: conn.deviceId,
        trigger,
        action: result.action,
        recovered: result.recovered,
        sessionPreserved: result.sessionPreserved,
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        reason: result.reason ?? null,
        at: this._nowIso(),
        schemaVersion: NETREL_SCHEMA_VERSION,
      });
    } catch {
      /* history is best-effort */
    }
  }

  /** @private */
  _eventFor(conn, extras = {}) {
    return { connectionId: conn.connectionId, deviceId: conn.deviceId, peerId: conn.peerId, state: conn.state, ...extras };
  }

  /** @private */
  _heartbeatExpiry(atIso) {
    return new Date(new Date(atIso).getTime() + this.heartbeatTimeoutMs).toISOString();
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Shape an active connection into its public DTO (whitelist; never key material). */
export function toPublicConnection(c) {
  if (!c) return null;
  return {
    connectionId: c.connectionId,
    deviceId: c.deviceId,
    peerId: c.peerId,
    sessionId: c.sessionId ?? null, // an id, not a key
    planId: c.planId ?? null,
    state: c.state,
    live: isLiveConnectionState(c.state),
    transport: c.transport,
    relayUsed: !!c.relayUsed,
    selectedPair: c.selectedPair ? { ...c.selectedPair } : null,
    health: { ...(c.health ?? {}) },
    reconnectCount: c.reconnectCount ?? 0,
    recoveryCount: c.recoveryCount ?? 0,
    establishedAt: c.establishedAt,
    lastActivityAt: c.lastActivityAt,
    updatedAt: c.updatedAt,
    version: c.version,
    metadata: c.metadata ?? {},
    schemaVersion: c.schemaVersion,
  };
}

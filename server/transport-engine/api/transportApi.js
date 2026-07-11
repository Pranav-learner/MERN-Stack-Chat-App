/**
 * @module transport-engine/api
 *
 * The **transport-engine service facade** — assembles a {@link TransportEngine} over a repository
 * bundle + an injected transport, wires the pump scheduler, and exposes the operations a controller
 * (or a device-local caller) needs: start / pause / resume / cancel a transfer, progress, chunk
 * status, diagnostics, and list active transfers. Keeps the HTTP layer free of engine wiring.
 */

import { TransportEngine } from "../manager/transportEngine.js";
import { TransportPumpScheduler } from "../scheduler/scheduler.js";
import { createInMemoryTransportRepository } from "../repository/inMemoryTransportRepository.js";
import { TransportEventBus } from "../events/events.js";

/**
 * Build a transport-engine service for a device.
 * @param {object} deps `{ deviceId, transport, repository?, events?, clock?, idGenerator?, options?, scheduler? }`
 * @returns {TransportEngineService}
 */
export function createTransportEngineService(deps) {
  return new TransportEngineService(deps);
}

export class TransportEngineService {
  constructor(deps) {
    if (!deps?.deviceId) throw new Error("TransportEngineService requires { deviceId }");
    if (!deps.transport) throw new Error("TransportEngineService requires { transport }");
    const repository = deps.repository ?? createInMemoryTransportRepository();
    this.repository = repository;
    this.events = deps.events ?? new TransportEventBus();
    this.engine = new TransportEngine({
      deviceId: deps.deviceId,
      transfers: repository.transfers,
      chunks: repository.chunks,
      progress: repository.progress,
      history: repository.history,
      audit: repository.audit,
      transport: deps.transport,
      events: this.events,
      clock: deps.clock,
      idGenerator: deps.idGenerator,
      options: deps.options,
    });
    this.scheduler = new TransportPumpScheduler({ engine: this.engine, intervalMs: deps.scheduler?.intervalMs });
    if (deps.scheduler?.autoStart) this.scheduler.start();
  }

  get deviceId() {
    return this.engine.deviceId;
  }

  onPayload(handler) {
    return this.engine.onPayload(handler);
  }
  onEvent(type, handler) {
    return this.engine.onEvent(type, handler);
  }
  receive(envelope) {
    return this.engine.receive(envelope);
  }
  startTransfer(request) {
    return this.engine.startTransfer(request);
  }
  pauseTransfer(transferId, options) {
    return this.engine.pauseTransfer(transferId, options);
  }
  resumeTransfer(transferId, options) {
    return this.engine.resumeTransfer(transferId, options);
  }
  cancelTransfer(transferId, options) {
    return this.engine.cancelTransfer(transferId, options);
  }
  getTransfer(transferId, options) {
    return this.engine.getTransfer(transferId, options);
  }
  getProgress(transferId) {
    return this.engine.getProgress(transferId);
  }
  getChunkStatus(transferId, options) {
    return this.engine.getChunkStatus(transferId, options);
  }
  listActiveTransfers(options) {
    return this.engine.listActiveTransfers(options);
  }
  getDiagnostics(transferId) {
    return this.engine.getDiagnostics(transferId);
  }
  pump() {
    return this.engine.pump();
  }
  sweepTimeouts(now) {
    return this.engine.sweepTimeouts(now);
  }
  start() {
    this.scheduler.start();
  }
  stop() {
    this.scheduler.stop();
  }
}

/**
 * @module transport-engine/lifecycle
 *
 * The deterministic finite state machines governing a **transfer** and a **chunk**. Pure logic — no
 * I/O, transport, or crypto. The {@link module:transport-engine/manager engine} validates every
 * transition through here.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> fragmenting
 *   fragmenting --> active
 *   active --> paused
 *   paused --> active
 *   active --> reassembling: (receiver)
 *   reassembling --> completed
 *   active --> completed
 *   active --> failed
 *   active --> cancelled
 *   active --> expired
 *   paused --> cancelled
 *   completed --> destroyed
 *   failed --> [*]
 *   expired --> [*]
 *   cancelled --> [*]
 *   destroyed --> [*]
 * ```
 */

import { TransferState, ChunkState, ALL_TRANSFER_STATES, ALL_CHUNK_STATES, isTerminalTransferState } from "../types/types.js";
import { InvalidTransferTransitionError } from "../errors.js";

/** Legal transfer transitions keyed by source state. */
export const ALLOWED_TRANSFER_TRANSITIONS = Object.freeze({
  [TransferState.CREATED]: [TransferState.FRAGMENTING, TransferState.ACTIVE, TransferState.REASSEMBLING, TransferState.CANCELLED, TransferState.EXPIRED, TransferState.FAILED],
  [TransferState.FRAGMENTING]: [TransferState.ACTIVE, TransferState.FAILED, TransferState.CANCELLED, TransferState.EXPIRED],
  [TransferState.ACTIVE]: [TransferState.PAUSED, TransferState.REASSEMBLING, TransferState.COMPLETED, TransferState.FAILED, TransferState.CANCELLED, TransferState.EXPIRED],
  [TransferState.PAUSED]: [TransferState.ACTIVE, TransferState.REASSEMBLING, TransferState.CANCELLED, TransferState.EXPIRED, TransferState.FAILED],
  [TransferState.REASSEMBLING]: [TransferState.ACTIVE, TransferState.PAUSED, TransferState.COMPLETED, TransferState.FAILED, TransferState.CANCELLED, TransferState.EXPIRED],
  [TransferState.COMPLETED]: [TransferState.DESTROYED],
  [TransferState.FAILED]: [TransferState.DESTROYED],
  [TransferState.CANCELLED]: [TransferState.DESTROYED],
  [TransferState.EXPIRED]: [TransferState.DESTROYED],
  [TransferState.DESTROYED]: [],
});

/** Legal chunk transitions keyed by source state. */
export const ALLOWED_CHUNK_TRANSITIONS = Object.freeze({
  [ChunkState.PENDING]: [ChunkState.SCHEDULED, ChunkState.SENT, ChunkState.FAILED],
  [ChunkState.SCHEDULED]: [ChunkState.SENT, ChunkState.PENDING, ChunkState.FAILED],
  [ChunkState.SENT]: [ChunkState.ACKED, ChunkState.SCHEDULED, ChunkState.PENDING, ChunkState.FAILED, ChunkState.SENT],
  [ChunkState.ACKED]: [],
  [ChunkState.RECEIVED]: [],
  [ChunkState.FAILED]: [ChunkState.SCHEDULED, ChunkState.PENDING],
});

/** Whether a transfer `from -> to` transition is legal (self-transition allowed). */
export function canTransferTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSFER_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transfer transition. @throws {InvalidTransferTransitionError} */
export function assertTransferTransition(from, to) {
  if (!ALL_TRANSFER_STATES.includes(to)) {
    throw new InvalidTransferTransitionError(`Unknown transfer state "${to}"`, { details: { from, to } });
  }
  if (!canTransferTransition(from, to)) {
    throw new InvalidTransferTransitionError(`Cannot transition transfer from "${from}" to "${to}"`, { details: { from, to, allowed: ALLOWED_TRANSFER_TRANSITIONS[from] ?? [] } });
  }
}

/** Whether a chunk `from -> to` transition is legal (self-transition allowed). */
export function canChunkTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_CHUNK_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a chunk transition. @throws {InvalidTransferTransitionError} */
export function assertChunkTransition(from, to) {
  if (!ALL_CHUNK_STATES.includes(to)) {
    throw new InvalidTransferTransitionError(`Unknown chunk state "${to}"`, { details: { from, to } });
  }
  if (!canChunkTransition(from, to)) {
    throw new InvalidTransferTransitionError(`Cannot transition chunk from "${from}" to "${to}"`, { details: { from, to, allowed: ALLOWED_CHUNK_TRANSITIONS[from] ?? [] } });
  }
}

/** States reachable from a transfer state in one step. */
export function nextTransferStates(state) {
  return [...(ALLOWED_TRANSFER_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful transfer-lifecycle driver that records transition history. Holds no I/O.
 */
export class TransferLifecycle {
  constructor(initial = TransferState.CREATED, options = {}) {
    if (!ALL_TRANSFER_STATES.includes(initial)) throw new InvalidTransferTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
    this._state = initial;
    this._clock = options.clock ?? (() => Date.now());
    this._history = options.history ? [...options.history] : [];
  }
  get state() {
    return this._state;
  }
  get history() {
    return [...this._history];
  }
  get isTerminal() {
    return isTerminalTransferState(this._state);
  }
  can(to) {
    return canTransferTransition(this._state, to);
  }
  transition(to, meta = {}) {
    assertTransferTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

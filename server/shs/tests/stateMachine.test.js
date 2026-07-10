import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HandshakeStateMachine,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
  nextStates,
} from "../state-machine/stateMachine.js";
import {
  HandshakeState,
  TERMINAL_HANDSHAKE_STATES,
  ACTIVE_HANDSHAKE_STATES,
  ALL_HANDSHAKE_STATES,
  isTerminalState,
} from "../types.js";
import { InvalidStateTransitionError } from "../errors.js";

describe("SHS state machine", () => {
  it("every state has a transition list; terminals have none", () => {
    for (const state of ALL_HANDSHAKE_STATES) {
      assert.ok(Array.isArray(ALLOWED_TRANSITIONS[state]), `missing ${state}`);
    }
    for (const state of TERMINAL_HANDSHAKE_STATES) {
      assert.deepEqual(ALLOWED_TRANSITIONS[state], [], `${state} must be terminal`);
    }
  });

  it("active states can all reach expired/timed_out/aborted", () => {
    for (const state of ACTIVE_HANDSHAKE_STATES) {
      if (state === HandshakeState.CREATED) continue; // created is pre-lifecycle
      assert.ok(canTransition(state, HandshakeState.EXPIRED), `${state}→expired`);
      assert.ok(canTransition(state, HandshakeState.TIMED_OUT), `${state}→timed_out`);
      assert.ok(canTransition(state, HandshakeState.ABORTED), `${state}→aborted`);
    }
  });

  it("canonical happy path is legal", () => {
    assert.ok(canTransition(HandshakeState.CREATED, HandshakeState.INITIALIZED));
    assert.ok(canTransition(HandshakeState.INITIALIZED, HandshakeState.WAITING));
    assert.ok(canTransition(HandshakeState.WAITING, HandshakeState.NEGOTIATING));
    assert.ok(canTransition(HandshakeState.NEGOTIATING, HandshakeState.COMPLETED));
  });

  it("illegal transitions are rejected", () => {
    assert.equal(canTransition(HandshakeState.CREATED, HandshakeState.COMPLETED), false);
    assert.equal(canTransition(HandshakeState.WAITING, HandshakeState.COMPLETED), false);
    assert.equal(canTransition(HandshakeState.COMPLETED, HandshakeState.WAITING), false);
    assert.throws(() => assertTransition(HandshakeState.COMPLETED, HandshakeState.WAITING), InvalidStateTransitionError);
  });

  it("is deterministic — no terminal state is reachable from another terminal", () => {
    for (const from of TERMINAL_HANDSHAKE_STATES) {
      assert.equal(nextStates(from).length, 0);
    }
  });

  it("HandshakeStateMachine drives + records history", () => {
    const fsm = new HandshakeStateMachine();
    assert.equal(fsm.state, HandshakeState.CREATED);
    fsm.transition(HandshakeState.INITIALIZED);
    fsm.transition(HandshakeState.WAITING, { reason: "request-sent" });
    fsm.transition(HandshakeState.NEGOTIATING);
    fsm.transition(HandshakeState.COMPLETED);
    assert.equal(fsm.state, HandshakeState.COMPLETED);
    assert.equal(fsm.isTerminal, true);
    assert.equal(fsm.history.length, 4);
    assert.equal(fsm.history[1].reason, "request-sent");
    // No further transitions from a terminal state.
    assert.throws(() => fsm.transition(HandshakeState.WAITING), InvalidStateTransitionError);
  });

  it("rejects an unknown initial state", () => {
    assert.throws(() => new HandshakeStateMachine("bogus"), InvalidStateTransitionError);
  });

  it("isTerminalState matches the terminal set", () => {
    assert.equal(isTerminalState(HandshakeState.COMPLETED), true);
    assert.equal(isTerminalState(HandshakeState.WAITING), false);
  });
});

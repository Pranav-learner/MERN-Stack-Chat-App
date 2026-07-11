/**
 * Test helpers for the Networking Hardening subsystem (Layer 6, Sprint 6). Node built-ins only.
 * Imports via SPECIFIC files (not index) so mongoose is never loaded — DB-free under `node --test`.
 * Not a test file.
 */

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A no-op sleep so retry/backoff tests never actually wait. */
export const noSleep = async () => {};

/** A monotonic id generator. */
export function makeIdGen(prefix = "alert") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** A repository stub whose method fails the first `failTimes` calls, then succeeds. */
export function flakyRepo(failTimes = 2) {
  let calls = 0;
  return {
    calls: () => calls,
    async findById(id) {
      calls++;
      if (calls <= failTimes) throw new Error("transient db error");
      return { id, ok: true, calls };
    },
  };
}

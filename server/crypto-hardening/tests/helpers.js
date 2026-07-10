/** Test helpers for the Cryptographic Hardening subsystem. Node built-ins only. Not a test file. */

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  return clock;
}

export function makeSessionId(seed = 1) {
  return `session-${String(seed).padStart(6, "0")}`;
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}

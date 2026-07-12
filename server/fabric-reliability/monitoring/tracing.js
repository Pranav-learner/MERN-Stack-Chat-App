/**
 * @module fabric-reliability/monitoring/tracing
 *
 * **Distributed-tracing hooks** (STEP 6) — a minimal, dependency-free span API so orchestration operations
 * can be traced without committing to a specific tracer. `startSpan` returns a span with `setAttribute`,
 * `addEvent`, and `end`; when a real tracer (OpenTelemetry, etc.) is injected, spans delegate to it,
 * otherwise they record locally + emit a structured record via the metrics logger. This is a FROZEN
 * extension point — a deployment wires its tracer here without touching the reliability core.
 *
 * @security Span attributes are ids + classifications + numbers only. No content.
 */

let SPAN_SEQ = 0;

export class Tracer {
  /**
   * @param {object} [opts]
   * @param {object} [opts.delegate] an external tracer with `startSpan(name, attrs) => span`
   * @param {(record: object) => void} [opts.sink] a structured sink for finished spans (default no-op)
   * @param {() => number} [opts.clock]
   */
  constructor(opts = {}) {
    this.delegate = opts.delegate ?? null;
    this.sink = opts.sink ?? (() => {});
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * Start a span. Returns a span handle; call `end()` to finish it.
   * @param {string} name @param {object} [attributes]
   * @returns {{ traceId, spanId, setAttribute, addEvent, end }}
   */
  startSpan(name, attributes = {}) {
    if (this.delegate?.startSpan) {
      const s = this.delegate.startSpan(name, attributes);
      return s;
    }
    const spanId = `span_${(SPAN_SEQ = (SPAN_SEQ + 1) % Number.MAX_SAFE_INTEGER)}`;
    const traceId = attributes.traceId ?? spanId;
    const start = this.clock();
    const attrs = { ...attributes };
    const events = [];
    return {
      traceId,
      spanId,
      setAttribute(k, v) {
        attrs[k] = v;
        return this;
      },
      addEvent(evName, evAttrs = {}) {
        events.push({ name: evName, ...evAttrs });
        return this;
      },
      end: (status = "ok") => {
        const record = { kind: "span", name, traceId, spanId, status, durationMs: this.clock() - start, attributes: attrs, events };
        try {
          this.sink(record);
        } catch {
          /* never break the caller */
        }
        return record;
      },
    };
  }
}

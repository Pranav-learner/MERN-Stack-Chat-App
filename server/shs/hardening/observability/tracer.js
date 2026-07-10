/**
 * @module shs/hardening/observability/tracer
 *
 * Minimal internal tracing hooks. Produces lightweight spans (name, timing,
 * attributes, status) with parent/child nesting, so a handshake or session operation
 * can be traced end-to-end. Export-agnostic — spans are plain objects a future
 * exporter (OpenTelemetry, Jaeger, …) can adapt. Off by default (zero overhead) until
 * `enabled`.
 *
 * @security Attributes should carry ids/states only — never keys or payloads. Callers
 * control what they attach.
 */

let __spanSeq = 0;

/** A single trace span. */
export class Span {
  constructor(name, { traceId, parentId, clock, attributes } = {}) {
    this.name = name;
    this.spanId = `span-${++__spanSeq}`;
    this.traceId = traceId ?? this.spanId;
    this.parentId = parentId ?? null;
    this._clock = clock ?? (() => Date.now());
    this.startTime = this._clock();
    this.endTime = null;
    this.attributes = { ...(attributes ?? {}) };
    this.status = "unset";
    this.events = [];
  }

  /** Attach an attribute. */
  set(key, value) {
    this.attributes[key] = value;
    return this;
  }

  /** Record a timestamped event within the span. */
  addEvent(name, attributes = {}) {
    this.events.push({ name, at: this._clock(), attributes });
    return this;
  }

  /** End the span with a status (`ok` | `error`). */
  end(status = "ok") {
    if (this.endTime === null) {
      this.endTime = this._clock();
      this.status = status;
    }
    return this;
  }

  /** Duration in ms (0 until ended). */
  get durationMs() {
    return this.endTime === null ? 0 : this.endTime - this.startTime;
  }
}

/** A tracer that records spans when enabled. */
export class Tracer {
  /** @param {{ enabled?: boolean, clock?: () => number, onSpanEnd?: (span: Span) => void, maxSpans?: number }} [options] */
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.clock = options.clock ?? (() => Date.now());
    this.onSpanEnd = options.onSpanEnd ?? null;
    this.maxSpans = options.maxSpans ?? 1000;
    this._spans = [];
  }

  /**
   * Start a span. Returns a {@link Span} (a no-op-ish span when disabled).
   * @param {string} name @param {{ parent?: Span, attributes?: object }} [options]
   */
  startSpan(name, options = {}) {
    const span = new Span(name, {
      clock: this.clock,
      traceId: options.parent?.traceId,
      parentId: options.parent?.spanId,
      attributes: options.attributes,
    });
    return span;
  }

  /** End a span and, if enabled, record it. */
  endSpan(span, status = "ok") {
    span.end(status);
    if (this.enabled) {
      this._spans.push(span);
      if (this._spans.length > this.maxSpans) this._spans.shift();
      if (this.onSpanEnd) {
        try {
          this.onSpanEnd(span);
        } catch {
          /* trace sinks must never break the traced path */
        }
      }
    }
    return span;
  }

  /**
   * Trace an async function as a span.
   * @template T @param {string} name @param {() => Promise<T>} fn @param {{ parent?: Span, attributes?: object }} [options]
   * @returns {Promise<T>}
   */
  async trace(name, fn, options = {}) {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      this.endSpan(span, "ok");
      return result;
    } catch (error) {
      span.set("error", error?.message);
      this.endSpan(span, "error");
      throw error;
    }
  }

  /** All recorded spans (when enabled). */
  get spans() {
    return [...this._spans];
  }

  /** Clear recorded spans. */
  reset() {
    this._spans = [];
  }
}

/**
 * @module optimization/scheduler/priorityQueue
 *
 * A **lane** — one isolated FIFO queue for a QoS class, with bounded capacity + starvation-prevention
 * aging. Each entry records its enqueue time; its EFFECTIVE priority is its class weight plus an aging
 * bonus that grows the longer it waits, so a long-waiting background item eventually out-prioritises a
 * fresh higher-class item (bounded, deterministic — no randomness). Lanes are the queue-isolation
 * primitive the scheduler dispatches from with weighted fairness.
 *
 * @security Entries carry the communication's control-plane descriptor + scheduling metadata only.
 */

import { DEFAULT_AGING_MS, DEFAULT_AGING_STEP } from "../types/types.js";
import { QueueOverflowError } from "../errors.js";

export class Lane {
  /**
   * @param {object} spec @param {string} spec.name @param {number} spec.capacity @param {number} spec.weight
   * @param {() => number} [spec.clock] @param {number} [spec.agingMs] @param {number} [spec.agingStep]
   */
  constructor(spec) {
    this.name = spec.name;
    this.capacity = spec.capacity;
    this.weight = spec.weight;
    this.clock = spec.clock ?? (() => Date.now());
    this.agingMs = spec.agingMs ?? DEFAULT_AGING_MS;
    this.agingStep = spec.agingStep ?? DEFAULT_AGING_STEP;
    /** @type {object[]} FIFO entries */
    this._items = [];
  }

  get size() {
    return this._items.length;
  }
  get isFull() {
    return this._items.length >= this.capacity;
  }

  /** Enqueue an item. @throws {QueueOverflowError} when the lane is at capacity. */
  enqueue(item) {
    if (this.isFull) throw new QueueOverflowError(`Lane "${this.name}" is at capacity (${this.capacity})`, { details: { lane: this.name, capacity: this.capacity } });
    const entry = { ...item, enqueuedAt: this.clock(), lane: this.name };
    this._items.push(entry);
    return entry;
  }

  /** The head entry without removing it. */
  peek() {
    return this._items[0] ?? null;
  }

  /** Remove + return the head entry. */
  dequeue() {
    return this._items.shift() ?? null;
  }

  /** Remove an entry by requestId. */
  remove(requestId) {
    const i = this._items.findIndex((e) => e.requestId === requestId);
    if (i < 0) return null;
    return this._items.splice(i, 1)[0];
  }

  /** The effective (aged) priority of the head entry — class weight + aging bonus. */
  headPriority() {
    const head = this._items[0];
    if (!head) return -Infinity;
    return this.effectivePriority(head);
  }

  /** Effective priority of an entry: static weight + (waited / agingMs) × agingStep. */
  effectivePriority(entry) {
    const waited = Math.max(0, this.clock() - (entry.enqueuedAt ?? this.clock()));
    return this.weight + Math.floor(waited / this.agingMs) * this.agingStep;
  }

  list() {
    return this._items.map((e) => ({ ...e }));
  }
}

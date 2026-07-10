/**
 * @module shs/key-agreement/repository/constants
 *
 * Shared constants for the key-agreement repositories (kept separate so both the
 * in-memory and Mongo implementations import them without a circular dependency).
 */

import { ExchangeState } from "../types.js";

/** Exchange states from which no further coordination happens. */
export const TERMINAL_EXCHANGE_STATES = new Set([ExchangeState.ESTABLISHED, ExchangeState.FAILED]);

/**
 * @module storage
 *
 * Storage abstraction + implementations. Depend on {@link KeyStorage}, never on a
 * concrete backend.
 */

export { KeyStorage, matchesFilter } from "./key-storage.js";
export { MemoryStorage } from "./memory-storage.js";
export { SecureStorage } from "./secure-storage.js";
export { DatabaseStorage, HardwareStorage, CloudKmsStorage } from "./placeholders.js";

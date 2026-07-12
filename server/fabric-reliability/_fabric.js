/**
 * @module fabric-reliability/_fabric
 *
 * Internal re-export of the frozen lower-layer symbols this reliability layer consumes, imported from
 * their SPECIFIC source files rather than the index barrels. The barrels additionally pull in Mongo-backed
 * repositories (→ `mongoose`), needed only by production wiring; importing the specific files keeps the
 * whole reliability layer — and its DB-free test suite — free of that dependency, exactly as every prior
 * `*-reliability` layer is. Pure re-export; adds no behaviour.
 */

export { deepFreeze } from "../communication-fabric/contexts/communicationContext.js";
export { FabricError } from "../communication-fabric/errors.js";

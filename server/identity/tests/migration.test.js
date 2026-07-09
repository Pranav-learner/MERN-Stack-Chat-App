import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reportIdentityAdoption } from "../migration/migration.js";
import { IdentityManager } from "../manager/identityManager.js";
import { createInMemoryRepositories } from "../repository/inMemoryRepository.js";
import { makeIdentityKey } from "./helpers.js";

/** Minimal fake of the existing Mongoose User model. */
function fakeUserModel(users) {
  return {
    find() {
      return { lean: async () => users };
    },
  };
}

describe("migration / backward compatibility", () => {
  it("reports which existing users lack an identity (backfill visibility)", async () => {
    const repos = createInMemoryRepositories();
    const manager = new IdentityManager(repos);

    // Two pre-existing users; only user-1 has generated an identity so far.
    const UserModel = fakeUserModel([
      { _id: "user-1", email: "a@x.com" },
      { _id: "user-2", email: "b@x.com" },
    ]);
    await manager.registerIdentity({ userId: "user-1", ...makeIdentityKey() });

    const report = await reportIdentityAdoption({ UserModel, identities: repos.identities });
    assert.equal(report.totalUsers, 2);
    assert.equal(report.withIdentity, 1);
    assert.equal(report.withoutIdentity, 1);
    assert.deepEqual(report.missing, [{ userId: "user-2", email: "b@x.com" }]);
  });

  it("existing users without an identity resolve to null (non-breaking)", async () => {
    const repos = createInMemoryRepositories();
    const manager = new IdentityManager(repos);
    assert.equal(await manager.getIdentityByUser("legacy-user"), null);
  });
});

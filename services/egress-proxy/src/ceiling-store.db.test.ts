import { createDb, egressDomains, sql, type KobeDatabase } from "@kobe/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadEgressCeilingWithInternal } from "./ceiling-store.js";

/**
 * EA4 (KOBE-603): the ceiling is read with each pattern's internal flag. The column comes with
 * KOBE-602's migration; until then every pattern reads as not internal (fail closed).
 */
let app: KobeDatabase;
let owner: KobeDatabase;
const suffix = Math.random().toString(36).slice(2, 8);
const INTERNAL = `*.apps-${suffix}.example.test`;
const PLAIN = `plain-${suffix}.example.test`;
const OFF = `off-${suffix}.example.test`;

const hasColumn = async () =>
  (
    await owner.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'egress_domains' AND column_name = 'internal'`)
  ).rows[0]?.n === 1;

const mine = async () =>
  (await loadEgressCeilingWithInternal(app.db))
    .filter((r) => typeof r !== "string" && r.domain.includes(suffix))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  app = createDb(inject("appUrl"));
  await app.db.insert(egressDomains).values([
    { domain: INTERNAL, inCeiling: true },
    { domain: PLAIN, inCeiling: true },
    { domain: OFF, inCeiling: false },
  ]);
});
afterAll(async () => {
  await app.close();
  await owner.close();
});

describe("loadEgressCeilingWithInternal", () => {
  it("reads every ceiling pattern, not internal unless flagged (column absent or false)", async () => {
    expect(await mine()).toEqual([
      { domain: INTERNAL, internal: false },
      { domain: PLAIN, internal: false },
    ]);
  });

  it("reads the internal flag once the column exists (KOBE-602's migration)", async () => {
    if (!(await hasColumn())) {
      // Stand-in for KOBE-602's migration on a branch that does not have it yet.
      await owner.db.execute(
        sql`ALTER TABLE egress_domains ADD COLUMN internal boolean NOT NULL DEFAULT false`,
      );
    }
    await owner.db.execute(
      sql`UPDATE egress_domains SET internal = true WHERE domain = ${INTERNAL}`,
    );
    expect(await mine()).toEqual([
      { domain: INTERNAL, internal: true },
      { domain: PLAIN, internal: false },
    ]);
  });
});

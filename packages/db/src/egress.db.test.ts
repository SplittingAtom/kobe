import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  CEILING_CHANGED,
  EGRESS_CHANGES_CHANNEL,
  isActiveTeamMember,
  loadEgressCeiling,
  loadTeamEgress,
  notifyEgressChanged,
} from "./egress/index.js";
import { egressDomains, teamEgress, teamMembers, teams, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-38: egress ceiling (install-wide) and team enablement (team table, RLS). */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const domain = `custom-${teamA.slice(0, 8)}.example.com`;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ea-${teamA.slice(0, 8)}`, name: "Egress A" },
    { id: teamB, slug: `eb-${teamB.slice(0, 8)}`, name: "Egress B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "E", email: `${userId}@e.test` });
  await withTeam(app.db, teamA, (tx) =>
    tx.insert(teamMembers).values({ teamId: teamA, userId, role: "team_admin" }),
  );
});
afterAll(() => app.close());

const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

describe("egress ceiling", () => {
  it("ships the presets: registries in the ceiling, git hosts listed but out of it", async () => {
    const ceiling = await loadEgressCeiling(app.db);
    expect(ceiling).toEqual(
      expect.arrayContaining([
        "pypi.org",
        "files.pythonhosted.org",
        "registry.npmjs.org",
        "deb.debian.org",
      ]),
    );
    expect(ceiling).not.toContain("github.com");
    const presets = await app.db.select().from(egressDomains);
    expect(presets.find((p) => p.domain === "github.com")).toMatchObject({
      preset: "git_hosts",
      inCeiling: false,
    });
  });

  it("refuses patterns outside the grammar (IPs, URLs, inner wildcards, uppercase)", async () => {
    for (const bad of ["10.0.0.1", "https://x.com", "a.*.com", "*.com", "Pypi.org", "x.com."]) {
      const err = await app.db
        .insert(egressDomains)
        .values({ domain: bad, inCeiling: true })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(pgCode(err), bad).toBe("23514");
    }
  });

  it("a fresh team reaches nothing: no team enables anything by default", async () => {
    expect(await loadTeamEgress(app.db, teamA)).toEqual([]);
    expect(await loadTeamEgress(app.db, teamB)).toEqual([]);
  });
});

describe("team enablement", () => {
  it("is confined to the team (RLS) and only references ceiling domains (FK)", async () => {
    await app.db.insert(egressDomains).values({ domain, inCeiling: true });
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamEgress).values({ teamId: teamA, domain, enabledBy: userId }),
    );
    expect(await loadTeamEgress(app.db, teamA)).toEqual([domain]);
    expect(await loadTeamEgress(app.db, teamB)).toEqual([]);
    const fk = await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(teamEgress)
        .values({ teamId: teamA, domain: "not-in-ceiling.example.com", enabledBy: userId }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgCode(fk)).toBe("23503");
    const rls = await withTeam(app.db, teamB, (tx) =>
      tx.insert(teamEgress).values({ teamId: teamA, domain: "pypi.org", enabledBy: userId }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgCode(rls)).toBe("42501");
  });

  it("deleting a custom ceiling domain removes every team's enablement of it", async () => {
    const other = `gone-${teamB.slice(0, 8)}.example.com`;
    await app.db.insert(egressDomains).values({ domain: other, inCeiling: true });
    for (const team of [teamA, teamB]) {
      await withTeam(app.db, team, (tx) =>
        tx.insert(teamEgress).values({ teamId: team, domain: other, enabledBy: userId }),
      );
    }
    await app.db.delete(egressDomains).where(sql`${egressDomains.domain} = ${other}`);
    expect(await loadTeamEgress(app.db, teamA)).not.toContain(other);
    expect(await loadTeamEgress(app.db, teamB)).toEqual([]);
  });
});

describe("liveness and change hints", () => {
  it("isActiveTeamMember: members yes, non-members and deactivated users no", async () => {
    expect(await isActiveTeamMember(app.db, teamA, userId)).toBe(true);
    expect(await isActiveTeamMember(app.db, teamB, userId)).toBe(false);
    const gone = randomUUID();
    await app.db.insert(users).values({ id: gone, name: "G", email: `${gone}@e.test` });
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamMembers).values({ teamId: teamA, userId: gone, role: "member" }),
    );
    expect(await isActiveTeamMember(app.db, teamA, gone)).toBe(true);
    await app.db.execute(sql`UPDATE users SET deactivated_at = now() WHERE id = ${gone}`);
    expect(await isActiveTeamMember(app.db, teamA, gone)).toBe(false);
  });

  it("delivers the change hint only when the writing transaction commits", async () => {
    const listener = new pg.Client({ connectionString: inject("appUrl") });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => heard.push(n.payload ?? ""));
    await listener.query(`LISTEN ${EGRESS_CHANGES_CHANNEL}`);
    await app.db
      .transaction(async (tx) => {
        await notifyEgressChanged(tx, teamA);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    await app.db.transaction((tx) => notifyEgressChanged(tx, null));
    await withTeam(app.db, teamB, (tx) => notifyEgressChanged(tx, teamB));
    await new Promise((r) => setTimeout(r, 200));
    await listener.end();
    expect(heard).toEqual([CEILING_CHANGED, teamB]);
  });
});

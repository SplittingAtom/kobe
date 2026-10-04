import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { connectors, teamConnectors, teamMembers, teams, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-58: connector registry (install-wide) and team enablement (team table, RLS). */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ca-${teamA.slice(0, 8)}`, name: "Connectors A" },
    { id: teamB, slug: `cb-${teamB.slice(0, 8)}`, name: "Connectors B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "C", email: `${userId}@c.test` });
  await withTeam(app.db, teamA, (tx) =>
    tx.insert(teamMembers).values({ teamId: teamA, userId, role: "team_admin" }),
  );
});
afterAll(() => app.close());

const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;
const unique = () => randomUUID().slice(0, 8);

async function insertConnector(name: string, url = "https://mcp.example.com/mcp") {
  const [row] = await app.db.insert(connectors).values({ name, url }).returning();
  if (!row) throw new Error("connector insert returned nothing");
  return row;
}

describe("connectors", () => {
  it("registers a connector with defaults: no auth, active, empty snapshot", async () => {
    const row = await insertConnector(`jira-${unique()}`);
    expect(row).toMatchObject({ authKind: "none", status: "active", toolsSnapshot: [] });
  });

  it.each([
    ["uppercase", "Jira"],
    ["double separator (would split Pi names)", "a__b"],
    ["leading separator", "-jira"],
    ["trailing separator", "jira_"],
    ["space", "my jira"],
    ["too long", "a".repeat(65)],
  ])("refuses a name with %s", async (_, name) => {
    await expect(insertConnector(name)).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });

  it("refuses names that differ only in - and _ (Pi treats them as one server)", async () => {
    const base = `dev-${unique()}`;
    await insertConnector(base);
    await expect(insertConnector(base.replace("-", "_"))).rejects.toSatisfy(
      (e) => pgCode(e) === "23505",
    );
  });

  it.each([
    ["no scheme", "mcp.example.com/mcp"],
    ["stdio command (remote only, D27)", "npx -y server"],
    ["file URL", "file:///etc/passwd"],
  ])("refuses a URL with %s", async (_, url) => {
    await expect(insertConnector(`u-${unique()}`, url)).rejects.toSatisfy(
      (e) => pgCode(e) === "23514",
    );
  });
});

describe("team_connectors", () => {
  it("is visible only to its own team (RLS)", async () => {
    const connector = await insertConnector(`rls-${unique()}`);
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamConnectors).values({
        teamId: teamA,
        connectorId: connector.id,
        exposure: "custom",
        enabledTools: ["mcp__x__y"],
        enabledBy: userId,
      }),
    );
    const inA = await withTeam(app.db, teamA, (tx) => tx.select().from(teamConnectors));
    const inB = await withTeam(app.db, teamB, (tx) => tx.select().from(teamConnectors));
    expect(inA.map((r) => r.connectorId)).toContain(connector.id);
    expect(inB).toEqual([]);
    expect(inA.find((r) => r.connectorId === connector.id)?.enabledTools).toEqual(["mcp__x__y"]);
  });

  it("cannot be written for another team", async () => {
    const connector = await insertConnector(`x-${unique()}`);
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx
          .insert(teamConnectors)
          .values({ teamId: teamB, connectorId: connector.id, enabledBy: userId }),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "42501");
  });

  it("goes away with the connector (deregistered)", async () => {
    const connector = await insertConnector(`gone-${unique()}`);
    await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(teamConnectors)
        .values({ teamId: teamA, connectorId: connector.id, enabledBy: userId }),
    );
    await app.db.delete(connectors).where(eq(connectors.id, connector.id));
    const rows = await withTeam(app.db, teamA, (tx) => tx.select().from(teamConnectors));
    expect(rows.map((r) => r.connectorId)).not.toContain(connector.id);
  });
});

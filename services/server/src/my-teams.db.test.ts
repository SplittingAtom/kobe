import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-456: a new sign-in session needs a usable default team. `/v1/me/teams` says which team the
 * user last made active (remembered per user, across sessions, while still a member) and, per
 * team, whether it is the Registry team and whether chat can run there (a model is enabled).
 */
let h: Harness;
let userId = "";
const registry = randomUUID();
const team1 = randomUUID();
const team2 = randomUUID();
const EMAIL = "maya@my-teams.test";

async function addTeam(id: string, slug: string, name: string, isRegistry = false): Promise<void> {
  await h.admin.query(`INSERT INTO teams (id, slug, name, registry) VALUES ($1, $2, $3, $4)`, [
    id,
    slug,
    name,
    isRegistry,
  ]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [id, userId],
  );
}

beforeAll(async () => {
  h = await openHarness();
  userId = await h.createUser(EMAIL);
  // "Skill Registry" sorts before "Team1" and "Team2", as on gate1.
  await addTeam(registry, "skill-registry", "Skill Registry", true);
  await addTeam(team1, "team1", "Team1");
  await addTeam(team2, "team2", "Team2");
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1)`,
    [userId],
  );
  await h.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1)`,
    [userId],
  );
  await h.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [team2, userId],
  );
});

afterAll(async () => {
  await h?.close();
});

describe("/v1/me/teams default-team hints (KOBE-456)", () => {
  it("marks the Registry team and the teams chat can run in; no last team at first", async () => {
    const b = await h.signIn(EMAIL);
    expect((await b.get("/v1/me/teams")).json).toEqual({
      activeTeamId: null,
      lastTeamId: null,
      teams: [
        {
          id: registry,
          slug: "skill-registry",
          name: "Skill Registry",
          role: "team_admin",
          registry: true,
          chatReady: false,
        },
        {
          id: team1,
          slug: "team1",
          name: "Team1",
          role: "team_admin",
          registry: false,
          chatReady: false,
        },
        {
          id: team2,
          slug: "team2",
          name: "Team2",
          role: "team_admin",
          registry: false,
          chatReady: true,
        },
      ],
    });
  });

  it("remembers the last active team per user, so a new session can start there", async () => {
    const first = await h.signIn(EMAIL);
    expect((await first.put("/v1/me/teams/active", { teamId: team1 })).status).toBe(200);
    const second = await h.signIn(EMAIL);
    const res = await second.get("/v1/me/teams");
    expect(res.json).toMatchObject({ activeTeamId: null, lastTeamId: team1 });
    // An explicit switch in any session moves it.
    expect((await second.put("/v1/me/teams/active", { teamId: team2 })).status).toBe(200);
    expect((await first.get("/v1/me/teams")).json).toMatchObject({
      activeTeamId: team1,
      lastTeamId: team2,
    });
  });

  it("leaves the last team unchanged when a switch is refused", async () => {
    const b = await h.signIn(EMAIL);
    expect((await b.put("/v1/me/teams/active", { teamId: randomUUID() })).status).toBe(403);
    expect((await b.get("/v1/me/teams")).json.lastTeamId).toBe(team2);
  });

  it("forgets a last team the user is no longer a member of", async () => {
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team2,
      userId,
    ]);
    const b = await h.signIn(EMAIL);
    const res = await b.get("/v1/me/teams");
    expect(res.json.lastTeamId).toBeNull();
    expect(res.json.teams.map((t: { id: string }) => t.id)).toEqual([registry, team1]);
  });
});

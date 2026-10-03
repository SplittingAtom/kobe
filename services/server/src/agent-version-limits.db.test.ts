import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * Limits on agent versions (KOBE-46 review M3): versions are immutable and never deleted by the
 * app, so each agent has a version cap, and publishes plus rollbacks share a per-user rate limit.
 */
let h: Harness;
let builder: TestBrowser;
let other: TestBrowser;
const team = randomUUID();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  h = await openHarness({
    agents: { maxVersions: 2, publishRate: { windowMs: 60_000, max: 4 } },
  });
  const ids = [await h.createUser("b@limits.test"), await h.createUser("o@limits.test")];
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'limits', 'Limits')`, [team]);
  for (const id of ids) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`,
      [team, id],
    );
  }
  builder = await h.signIn("b@limits.test");
  other = await h.signIn("o@limits.test");
  for (const b of [builder, other]) {
    expect((await b.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    b.team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

async function agent(b: TestBrowser, name: string): Promise<string> {
  const res = await b.post("/v1/agents", { scope: "team", frontmatter: { name }, prompt: "v0" });
  expect(res.status).toBe(201);
  return res.json.agent.id as string;
}

const edit = (b: TestBrowser, id: string, prompt: string) =>
  b.put(`/v1/agents/${id}`, { frontmatter: { name: "Edited" }, prompt }, ANY);
const publish = (b: TestBrowser, id: string) =>
  b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);

describe("agent version limits", () => {
  it("caps versions per agent (config), counting rollbacks", async () => {
    const id = await agent(builder, "Capped");
    expect((await publish(builder, id)).status).toBe(201);
    await edit(builder, id, "v2");
    expect((await publish(builder, id)).status).toBe(201);
    await edit(builder, id, "v3");
    const third = await publish(builder, id);
    expect(third).toMatchObject({ status: 409, json: { code: "version_limit_reached" } });
    const rollback = await builder.post(`/v1/agents/${id}/rollback`, { version: 1 });
    expect(rollback.json.code).toBe("version_limit_reached");
  });

  it("rate-limits publishes and rollbacks per user, not per team", async () => {
    // The builder has used 4 of 4 in the test above (3 publishes + 1 rollback).
    const id = await agent(builder, "Throttled");
    const limited = await publish(builder, id);
    expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    expect((await builder.post(`/v1/agents/${id}/rollback`, { version: 1 })).status).toBe(429);
    const theirs = await agent(other, "Unaffected");
    expect((await publish(other, theirs)).status).toBe(201);
  });
});

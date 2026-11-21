import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TeamVariables } from "./middleware.js";
import { actorOf } from "./actor.js";

async function actorFor(siteRole: string | undefined) {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.get("/", (c) => {
    c.set("user", { id: "u1" } as never);
    c.set("team", { id: "t1", role: "member" } as never);
    if (siteRole) c.set("siteRole", siteRole as never);
    return c.json(actorOf(c));
  });
  return (await app.request("/")).json();
}

describe("actorOf", () => {
  it("is the verified caller from the session and active team", async () => {
    expect(await actorFor("admin")).toEqual({
      user_id: "u1",
      team_id: "t1",
      site_role: "admin",
      team_role: "member",
    });
  });

  it("defaults the site role to user", async () => {
    expect(await actorFor(undefined)).toMatchObject({ site_role: "user" });
  });
});

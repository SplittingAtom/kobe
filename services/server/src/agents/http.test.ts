import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AgentAccess } from "./access.js";
import { agentSummary, readIfMatch } from "./http.js";
import type { AgentRecord } from "./store.js";

async function ifMatch(header?: string) {
  const app = new Hono();
  app.get("/", (c) => c.json(readIfMatch(c)));
  const res = await app.request(
    "/",
    header === undefined ? {} : { headers: { "if-match": header } },
  );
  return res.json();
}

describe("readIfMatch", () => {
  it("distinguishes a missing header from an explicit *", async () => {
    expect(await ifMatch()).toEqual({ kind: "missing" });
    expect(await ifMatch("*")).toEqual({ kind: "any" });
  });

  it("reads strong and weak ETags", async () => {
    expect(await ifMatch('"7"')).toEqual({ kind: "revision", revision: 7 });
    expect(await ifMatch('W/"7"')).toEqual({ kind: "revision", revision: 7 });
  });

  it("flags anything else as invalid", async () => {
    for (const bad of ["7", '"x"', '"1", "2"', `"${"9".repeat(12)}"`]) {
      expect(await ifMatch(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("agentSummary rights", () => {
  const agent = {
    id: "a",
    scope: "team",
    slug: "x",
    frontmatter: { name: "X" },
    status: "active",
    ownerUserId: null,
    currentVersion: null,
    archivedAt: null,
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as AgentRecord;
  const access = (edit: boolean, publish: boolean): AgentAccess => ({
    see: true,
    readDefinition: true,
    edit,
    publish,
    setStatus: false,
  });

  it("reports whether the definition (and so an export) may be read", () => {
    const member: AgentAccess = { ...access(false, false), readDefinition: false };
    expect(agentSummary(agent, member)).toMatchObject({ canExport: false });
    expect(agentSummary(agent, access(false, false))).toMatchObject({ canExport: true });
  });

  it("reports edit and publish separately", () => {
    expect(agentSummary(agent, access(true, false))).toMatchObject({
      canEdit: true,
      canPublish: false,
    });
    expect(agentSummary(agent, access(true, true))).toMatchObject({
      canEdit: true,
      canPublish: true,
    });
  });
});

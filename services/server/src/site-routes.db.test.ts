import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-255: the site console's API moved from the install prefix to /v1/site/*, with no aliases (only
 * the web app, the e2e scripts and the docs in this repository called it). Permissions are site.*.
 */
const READS = [
  "settings",
  "web-search",
  "teams",
  "roles",
  "policy/rules",
  "users",
  "invites",
  "gallery/agents",
  "audit",
  "egress-ceiling",
  "models",
  "usage",
  "budget",
  "break-glass",
  "legal-hold",
  "retention",
  "connectors",
  "skill-blocklist",
] as const;

/** The retired prefix, to check nothing answers there any more. */
const RETIRED = "/v1/install"; // site-identifiers: allow

let h: Harness;
let owner: TestBrowser;
let user: TestBrowser;

beforeAll(async () => {
  h = await openHarness();
  await h.createUser("owner@site.test", "owner");
  await h.createUser("user@site.test");
  owner = await h.signIn("owner@site.test");
  user = await h.signIn("user@site.test");
});
afterAll(async () => {
  await h?.close();
});

describe("/v1/site", () => {
  it.each(READS)("serves GET /v1/site/%s to the site Owner and refuses a plain user", async (p) => {
    const res = await owner.get(`/v1/site/${p}`);
    expect(res.status, `${p}: ${JSON.stringify(res.json)}`).toBe(200);
    expect((await user.get(`/v1/site/${p}`)).status).toBe(403);
  });

  it.each(READS)(`no longer answers GET ${RETIRED}/%s`, async (p) => {
    expect((await owner.get(`${RETIRED}/${p}`)).status).toBe(404);
  });

  it("names the caller's site role in /v1/me", async () => {
    const me = await owner.get("/v1/me");
    expect(me.json.siteRole).toBe("owner");
    expect(me.json).not.toHaveProperty("installRole"); // site-identifiers: allow
    expect((await user.get("/v1/me")).json.siteRole).toBeNull();
  });

  it("lists users with their site role", async () => {
    const res = await owner.get("/v1/site/users");
    const roles = Object.fromEntries(
      (res.json.users as { email: string; siteRole: string }[]).map((u) => [u.email, u.siteRole]),
    );
    expect(roles).toEqual({ "owner@site.test": "owner", "user@site.test": "user" });
  });
});

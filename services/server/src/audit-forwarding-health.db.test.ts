import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forwardingSecrets } from "./audit/forward/redact.js";
import { initialState, writeState } from "./audit/forward/state.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-182: the forwarding health view (`GET /v1/site/audit/forwarding`) as configured by Helm
 * values, read by the site console's Audit forwarding page. Errors stored before redaction existed
 * (KOBE-19 kept fetch's message verbatim) must still show no credentials.
 */

const API_KEY = "k3y-s3cret-value-42";
const OTLP = {
  url: "https://siem-user:p@ss@collector.example.test/v1/logs",
  headers: { "x-api-key": API_KEY },
};
const LEGACY_ERROR =
  "Request cannot be constructed from a URL that includes credentials: " +
  "https://siem-user:p@ss@collector.example.test/ingest/t0k3n-in-path?x=1 " +
  `(collector rejected X-Api-Key ${API_KEY})`;

let h: Harness;
let admin: TestBrowser;
let teamAdmin: TestBrowser;
let member: TestBrowser;

beforeAll(async () => {
  h = await openHarness({
    auditForwardingDestinations: ["otlp"],
    auditForwardingSecrets: forwardingSecrets({ otlp: OTLP }),
  });
  const setup = await h.browser().post("/v1/setup", {
    setupToken: "setup-token-for-harness-tests-01",
    email: "owner@fwd.test",
    name: "Owner",
    password: "a long enough password",
  });
  expect(setup.status).toBe(201);
  await h.createUser("admin@fwd.test", "admin");
  const teamAdminId = await h.createUser("lead@fwd.test");
  await h.createUser("member@fwd.test");
  admin = await h.signIn("admin@fwd.test");
  teamAdmin = await h.signIn("lead@fwd.test");
  member = await h.signIn("member@fwd.test");
  const team = await admin.post("/v1/site/teams", {
    slug: "security",
    name: "Security",
    adminUserId: teamAdminId,
  });
  expect(team.status).toBe(201);
  await teamAdmin.put("/v1/me/teams/active", { teamId: team.json.team.id });
});

afterAll(async () => {
  await h?.close();
});

describe("GET /v1/site/audit/forwarding (KOBE-182)", () => {
  it("is refused to a member and to a team admin", async () => {
    expect((await member.get("/v1/site/audit/forwarding")).status).toBe(403);
    expect((await teamAdmin.get("/v1/site/audit/forwarding")).status).toBe(403);
  });

  it("redacts a legacy raw error on read, configured secrets included", async () => {
    await writeState(h.deps.database.db, "otlp", {
      ...initialState(0),
      failures: 6,
      lastErrorAt: new Date().toISOString(),
      lastError: LEGACY_ERROR,
    });
    const res = await admin.get("/v1/site/audit/forwarding");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ enabled: true });
    const [otlp] = res.json.destinations;
    expect(otlp).toMatchObject({ destination: "otlp", status: "failing", failures: 6 });
    // What the Audit forwarding page renders comes from this body.
    const body = JSON.stringify(res.json);
    for (const secret of ["siem-user", "p@ss", "t0k3n-in-path", "x=1", API_KEY]) {
      expect(body).not.toContain(secret);
    }
    expect(otlp.lastError).toContain("https://[redacted]@collector.example.test/[redacted]");
    expect(otlp.lastError).toContain("X-Api-Key [redacted]");
  });
});

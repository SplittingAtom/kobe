import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHarness, type Harness } from "./testing/harness.js";
import type { TestBrowser } from "./testing/browser.js";

/**
 * KOBE-703 (review CODE-26): `PUT /v1/team/budgets/eval-cap` read `"evalCap" in body` on an
 * unvalidated body, so a JSON number or string answered 500. Every body that is not
 * `{evalCap: {usd} | {tokens} | null}` is a 400 `invalid_request` with the route's message.
 */
let h: Harness;
let admin: TestBrowser;
const team = randomUUID();
const EMAIL = "cap@eval-cap-body.test";
const PATH = "/v1/team/budgets/eval-cap";
const SEND = "Send evalCap: {usd} (dollars, whole cents) or {tokens} per month, or null for none.";

beforeAll(async () => {
  h = await openHarness();
  const userId = await h.createUser(EMAIL);
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'cap-team', 'Cap team')`, [
    team,
  ]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [team, userId],
  );
  admin = await h.signIn(EMAIL);
  expect((await admin.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
});

afterAll(async () => {
  await h?.close();
});

const put = (body: unknown) => admin.put(PATH, body, { "x-kobe-team": team });

describe("PUT /v1/team/budgets/eval-cap body validation (KOBE-703)", () => {
  it.each([
    ["a number", 5],
    ["a string", "x"],
    ["an array", []],
    ["null", null],
    ["an empty object", {}],
  ])("answers 400 invalid_request for %s", async (_label, body) => {
    const res = await put(body);
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json).toEqual({ code: "invalid_request", message: SEND });
  });

  it("clears the cap with {evalCap: null}", async () => {
    const res = await put({ evalCap: null });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  });
});

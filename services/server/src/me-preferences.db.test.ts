import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RawBody } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/** KOBE-202 (CE8): layout preferences per user, server-side, following the member across devices. */
let h: Harness;
let aliceId = "";
let bobId = "";
const PATH = "/v1/me/preferences";

beforeAll(async () => {
  h = await openHarness();
  aliceId = await h.createUser("alice@prefs.test");
  bobId = await h.createUser("bob@prefs.test");
});
afterAll(() => h.close());

const stored = async (id: string) =>
  (await h.admin.query(`SELECT ui_preferences FROM users WHERE id = $1`, [id])).rows[0]
    ?.ui_preferences as unknown;

describe("/v1/me/preferences", () => {
  it("needs a session", async () => {
    expect((await h.browser().get(PATH)).status).toBe(401);
  });

  it("starts empty: every layout default applies", async () => {
    const b = await h.signIn("alice@prefs.test");
    const res = await b.get(PATH);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ preferences: {} });
  });

  it("follows the member to another browser (ac-1)", async () => {
    const laptop = await h.signIn("alice@prefs.test");
    const phone = await h.signIn("alice@prefs.test");
    const put = await laptop.put(PATH, {
      rail_collapsed: true,
      threads_share: 0.45,
      artifact_width: 720,
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({
      preferences: { rail_collapsed: true, threads_share: 0.45, artifact_width: 720 },
    });
    expect((await phone.get(PATH)).json).toEqual(put.json);
  });

  it("stores only the keys sent and keeps the others; null resets the width", async () => {
    const b = await h.signIn("alice@prefs.test");
    await b.put(PATH, { rail_collapsed: false, threads_share: 0.6, artifact_width: 500 });
    const res = await b.put(PATH, { artifact_width: null });
    expect(res.json).toEqual({
      preferences: { rail_collapsed: false, threads_share: 0.6, artifact_width: null },
    });
  });

  it("stores the rail's width per member, and null resets it (KOBE-305)", async () => {
    const laptop = await h.signIn("alice@prefs.test");
    const phone = await h.signIn("alice@prefs.test");
    const put = await laptop.put(PATH, { rail_width: 420 });
    expect(put.status).toBe(200);
    expect(put.json.preferences.rail_width).toBe(420);
    expect((await phone.get(PATH)).json).toEqual(put.json);
    const reset = await phone.put(PATH, { rail_width: null });
    expect(reset.json.preferences.rail_width).toBeNull();
    // The other keys are kept.
    expect(reset.json.preferences).toEqual({ ...put.json.preferences, rail_width: null });
  });

  it("clamps the threads share to the rail's bounds", async () => {
    const b = await h.signIn("alice@prefs.test");
    expect((await b.put(PATH, { threads_share: 0.95 })).json.preferences.threads_share).toBe(0.8);
    expect((await b.put(PATH, { threads_share: 0.01 })).json.preferences.threads_share).toBe(0.2);
  });

  it.each([
    ["an unknown key", { rail_collapsed: true, theme: "dark" }],
    ["a width under the floor", { artifact_width: 359 }],
    ["an absurd width", { artifact_width: 100_000 }],
    ["a fractional width", { artifact_width: 512.5 }],
    ["a rail width under its minimum", { rail_width: 199 }],
    ["a rail width over its maximum", { rail_width: 561 }],
    ["a share outside 0..1", { threads_share: 1.5 }],
    ["a non-boolean rail state", { rail_collapsed: "yes" }],
    ["an array", [true]],
  ])("refuses %s with 400 and stores nothing (ac-3)", async (_label, body) => {
    const b = await h.signIn("bob@prefs.test");
    await b.put(PATH, { rail_collapsed: false });
    const before = await stored(bobId);
    const res = await b.put(PATH, body);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_request");
    expect(await stored(bobId)).toEqual(before);
  });

  it("refuses a body over the size bound with 413", async () => {
    const b = await h.signIn("bob@prefs.test");
    const big = new RawBody(
      JSON.stringify({ rail_collapsed: true, pad: "x".repeat(2048) }),
      "application/json",
    );
    expect((await b.put(PATH, big)).status).toBe(413);
  });

  it("only ever writes the caller's own row", async () => {
    const alice = await h.signIn("alice@prefs.test");
    const bob = await h.signIn("bob@prefs.test");
    await alice.put(PATH, { artifact_width: 640, rail_collapsed: false });
    const aliceBefore = await stored(aliceId);
    await bob.put(PATH, { artifact_width: 900, rail_collapsed: true });
    expect(await stored(aliceId)).toEqual(aliceBefore);
    expect((await alice.get(PATH)).json.preferences).toMatchObject({ artifact_width: 640 });
    expect((await bob.get(PATH)).json.preferences).toMatchObject({ artifact_width: 900 });
  });

  it("can't be pointed at another user's row", async () => {
    const alice = await h.signIn("alice@prefs.test");
    const bob = await h.signIn("bob@prefs.test");
    await bob.put(PATH, { rail_collapsed: false, artifact_width: 900 });
    const bobBefore = await stored(bobId);
    expect((await alice.put(PATH, { id: bobId, rail_collapsed: true })).status).toBe(400);
    expect((await alice.put(PATH, { user_id: bobId, rail_collapsed: true })).status).toBe(400);
    expect((await alice.put(`${PATH}?user_id=${bobId}`, { rail_collapsed: true })).status).toBe(
      200,
    );
    expect(
      (await alice.put(`/v1/users/${bobId}/preferences`, { artifact_width: 400 })).status,
    ).toBe(404);
    expect(await stored(bobId)).toEqual(bobBefore);
    expect(await stored(aliceId)).toMatchObject({ rail_collapsed: true });
  });

  it("maps the column's size CHECK to 400, never 500", async () => {
    const b = await h.signIn("bob@prefs.test");
    // A stored document already at the CHECK's limit (jsonb text bytes), from outside this route.
    await h.admin.query(
      `UPDATE users SET ui_preferences = jsonb_build_object('legacy', repeat('x', 4096 - 15))
        WHERE id = $1`,
      [bobId],
    );
    const { rows } = await h.admin.query(
      `SELECT octet_length(ui_preferences::text) AS n FROM users WHERE id = $1`,
      [bobId],
    );
    expect(rows[0]?.n).toBe(4096 - 15 + 14);
    const before = await stored(bobId);
    const res = await b.put(PATH, { rail_collapsed: true, artifact_width: 1024 });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_request");
    expect(await stored(bobId)).toEqual(before);
    await h.admin.query(`UPDATE users SET ui_preferences = NULL WHERE id = $1`, [bobId]);
  });

  it("drops stored values that no longer validate when reading", async () => {
    const b = await h.signIn("bob@prefs.test");
    await h.admin.query(
      `UPDATE users SET ui_preferences = '{"rail_collapsed": true, "artifact_width": 12, "old": 1}' WHERE id = $1`,
      [bobId],
    );
    expect((await b.get(PATH)).json).toEqual({ preferences: { rail_collapsed: true } });
  });
});

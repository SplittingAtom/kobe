import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { UI_PREFERENCES_MAX_BYTES } from "./schema/auth.js";

/**
 * KOBE-202 (CE8): `users.ui_preferences` holds a user's layout preferences. The app role reads and
 * writes it under the existing table grants; the CHECK keeps it a small JSON object (the server
 * validates the exact shape).
 */
const app = new pg.Client({ connectionString: inject("appUrl") });
await app.connect();
afterAll(() => app.end());

let userId = "";
beforeEach(async () => {
  userId = randomUUID();
  await app.query(`INSERT INTO users (id, name, email) VALUES ($1, 'P', $2)`, [
    userId,
    `${userId}@p.test`,
  ]);
});

const write = (value: string | null) =>
  app.query(`UPDATE users SET ui_preferences = $2::jsonb WHERE id = $1`, [userId, value]);
const read = async () =>
  (await app.query(`SELECT ui_preferences FROM users WHERE id = $1`, [userId])).rows[0]
    ?.ui_preferences as unknown;

describe("users.ui_preferences", () => {
  it("is NULL for a new user", async () => {
    expect(await read()).toBeNull();
  });

  it("lets the app role store, replace and clear an object", async () => {
    await write(JSON.stringify({ rail_collapsed: true, threads_share: 0.4 }));
    expect(await read()).toEqual({ rail_collapsed: true, threads_share: 0.4 });
    await write(JSON.stringify({ artifact_width: null }));
    expect(await read()).toEqual({ artifact_width: null });
    await write(null);
    expect(await read()).toBeNull();
  });

  it.each([["[]"], ["true"], ["42"], ['"wide"'], ["null"]])(
    "refuses non-object JSON %s",
    async (v) => {
      await expect(write(v)).rejects.toMatchObject({ code: "23514" });
    },
  );

  /** `{"x": "<n>"}` as jsonb text: jsonb renders a space after the colon, so 9 bytes plus n. */
  const ofBytes = (bytes: number) => JSON.stringify({ x: "a".repeat(bytes - 9) });
  const storedBytes = async () =>
    (
      await app.query(`SELECT octet_length(ui_preferences::text) AS n FROM users WHERE id = $1`, [
        userId,
      ])
    ).rows[0]?.n as number;

  it("accepts exactly the bound, measured as jsonb text", async () => {
    await write(ofBytes(UI_PREFERENCES_MAX_BYTES));
    expect(await storedBytes()).toBe(UI_PREFERENCES_MAX_BYTES);
  });

  it("refuses one byte over the bound", async () => {
    await expect(write(ofBytes(UI_PREFERENCES_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("refuses an object larger than the bound", async () => {
    const big = JSON.stringify({ x: "a".repeat(UI_PREFERENCES_MAX_BYTES) });
    await expect(write(big)).rejects.toMatchObject({ code: "23514" });
  });
});

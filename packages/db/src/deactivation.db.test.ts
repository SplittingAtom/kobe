import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";

/**
 * KOBE-13: the sessions trigger refuses sessions for deactivated users, and its row lock makes a
 * sign-in racing a deactivation end with no live session either way.
 */
const a = new pg.Client({ connectionString: inject("appUrl") });
const b = new pg.Client({ connectionString: inject("appUrl") });
await a.connect();
await b.connect();
afterAll(async () => {
  await a.end();
  await b.end();
});

let userId = "";
beforeEach(async () => {
  userId = randomUUID();
  await a.query(`INSERT INTO users (id, name, email) VALUES ($1, 'D', $2)`, [
    userId,
    `${userId}@d.test`,
  ]);
});

const insertSession = (client: pg.Client) =>
  client.query(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [userId, randomUUID()],
  );
const sessionCount = async () =>
  (await a.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [userId])).rows[0]
    .n as number;
const deactivate = `UPDATE users SET deactivated_at = now() WHERE id = $1`;
const deleteSessions = `DELETE FROM sessions WHERE user_id = $1`;

describe("sessions_refuse_deactivated trigger", () => {
  it("allows sessions for active users", async () => {
    await insertSession(a);
    expect(await sessionCount()).toBe(1);
  });

  it("refuses a session for a deactivated user", async () => {
    await a.query(deactivate, [userId]);
    await expect(insertSession(a)).rejects.toMatchObject({ code: "42501" });
  });

  it("a sign-in waiting on a deactivation fails once it commits", async () => {
    await a.query("BEGIN");
    await a.query(deactivate, [userId]);
    await a.query(deleteSessions, [userId]);
    const signIn = insertSession(b);
    await a.query("COMMIT");
    await expect(signIn).rejects.toMatchObject({ code: "42501" });
    expect(await sessionCount()).toBe(0);
  });

  it("a deactivation waiting on a sign-in still deletes the new session", async () => {
    await b.query("BEGIN");
    await insertSession(b);
    const deactivation = (async () => {
      await a.query("BEGIN");
      await a.query(deactivate, [userId]);
      await a.query(deleteSessions, [userId]);
      await a.query("COMMIT");
    })();
    await new Promise((r) => setTimeout(r, 200));
    await b.query("COMMIT");
    await deactivation;
    expect(await sessionCount()).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { isRunTokenActive, recordRunToken, revokeRunTokens } from "./models/index.js";
import { runs, sandboxRunLeases, teams, threads, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-118: the run_tokens record and the gateway's stateful check. */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const sandboxId = randomUUID();

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ta-${teamA.slice(0, 8)}`, name: "Tokens A" },
    { id: teamB, slug: `tb-${teamB.slice(0, 8)}`, name: "Tokens B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "T", email: `${userId}@t.test` });
});
afterAll(() => app.close());

async function leasedRun(): Promise<string> {
  return withTeam(app.db, teamA, async (tx) => {
    const [thread] = await tx
      .insert(threads)
      .values({ teamId: teamA, ownerUserId: userId })
      .returning({ id: threads.id });
    if (!thread) throw new Error("no thread");
    const [run] = await tx
      .insert(runs)
      .values({
        teamId: teamA,
        threadId: thread.id,
        trigger: "user",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: runs.id });
    if (!run) throw new Error("no run");
    await tx
      .insert(sandboxRunLeases)
      .values({ teamId: teamA, runId: run.id, userId, threadId: thread.id, sandboxId });
    return run.id;
  });
}

async function mint(runId: string, expiresAt = new Date(Date.now() + 60_000)) {
  const jti = randomUUID();
  await withTeam(app.db, teamA, (tx) =>
    recordRunToken(tx, { teamId: teamA, jti, runId, sandboxId, expiresAt }),
  );
  return { teamId: teamA, jti, runId, sandboxId };
}

describe("run token record", () => {
  it("is active while the run is, and only for its own run, sandbox and team", async () => {
    const runId = await leasedRun();
    const subject = await mint(runId);
    expect(await isRunTokenActive(app.db, subject)).toBe(true);
    expect(await isRunTokenActive(app.db, { ...subject, runId: randomUUID() })).toBe(false);
    expect(await isRunTokenActive(app.db, { ...subject, sandboxId: randomUUID() })).toBe(false);
    expect(await isRunTokenActive(app.db, { ...subject, jti: randomUUID() })).toBe(false);
    expect(await isRunTokenActive(app.db, { ...subject, teamId: teamB })).toBe(false);
  });

  it("is refused once revoked", async () => {
    const subject = await mint(await leasedRun());
    await withTeam(app.db, teamA, (tx) => revokeRunTokens(tx, teamA, subject.runId));
    expect(await isRunTokenActive(app.db, subject)).toBe(false);
  });

  it("is refused after expiry", async () => {
    const subject = await mint(await leasedRun(), new Date(Date.now() - 1_000));
    expect(await isRunTokenActive(app.db, subject)).toBe(false);
  });

  it("is refused when the run ended without a revocation", async () => {
    const runId = await leasedRun();
    const subject = await mint(runId);
    await withTeam(app.db, teamA, (tx) =>
      tx.execute(
        sql`UPDATE runs SET status = 'completed', ended_at = now() WHERE team_id = ${teamA} AND id = ${runId}`,
      ),
    );
    expect(await isRunTokenActive(app.db, subject)).toBe(false);
  });
});

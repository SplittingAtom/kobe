import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunFixture, type FakeWorkspace, type RunStart } from "./testing/run-fixture.js";

/**
 * KOBE-492 review: a thread's untold sync conflicts ride its next `run.start` and are marked told
 * only once the sandbox accepted that start. A start lost with a dropped connection leaves them
 * untold, so the next start carries them again.
 */
const f = new RunFixture();
const CAPS = ["skill_bundles", "sync_conflicts"];
const SHA = "c".repeat(64);

beforeAll(async () => {
  await f.setup({ startTimeoutMs: 3_000, runMaxBytes: 256 * 1024 });
});

afterAll(async () => {
  await f.teardown();
});

async function told(team: string, threadId: string): Promise<boolean[]> {
  const { rows } = await f.fx.admin.query<{ told: boolean }>(
    `SELECT agent_notified_at IS NOT NULL AS told FROM workspace_sync_conflicts
      WHERE team_id = $1 AND thread_id = $2 ORDER BY created_at`,
    [team, threadId],
  );
  return rows.map((r) => r.told);
}

const withConflicts = (ws: FakeWorkspace) =>
  ws.starts().filter((s: RunStart) => (s.sync_conflicts ?? []).length > 0);

describe("run.start sync conflicts (KOBE-492)", () => {
  it("marks them told only after the sandbox accepts the start; a dropped start re-sends", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    await f.fx.admin.query(
      `INSERT INTO workspace_sync_conflicts
         (team_id, user_id, thread_id, path, conflict_path, member_sha256, agent_sha256)
       VALUES ($1, $2, $3, 'notes.md', 'notes.conflict-20261023T120000Z.md', $4, $4)`,
      [w.team, w.owner.id, threadId, SHA],
    );

    // The first sandbox never answers the start (it fails), then its connection drops.
    const first = await f.connect(w, 0, CAPS);
    first.sb.respond = (frame) => (frame.type === "run.start" ? null : undefined);
    const run1 = await f.message(w.owner, threadId, "first");
    await first.sb.until(() => withConflicts(first)[0]);
    expect(withConflicts(first)[0]?.sync_conflicts).toEqual([
      {
        path: "notes.md",
        conflict_path: "notes.conflict-20261023T120000Z.md",
        member_sha256: SHA,
        agent_sha256: SHA,
      },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await told(w.team, threadId)).toEqual([false]);
    first.kill();

    // The next sandbox gets them again with the next start and accepts it: told now.
    await f.until(w.team, run1, "failed");
    const second = await f.connect(w, 0, CAPS);
    await f.message(w.owner, threadId, "second");
    await second.sb.until(() => withConflicts(second)[0], 15_000);
    for (let i = 0; i < 50 && !(await told(w.team, threadId))[0]; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await told(w.team, threadId)).toEqual([true]);
  }, 60_000);
});

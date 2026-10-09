import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { sql, teamMembers, withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { createSandboxLifecycle } from "./sandbox-lifecycle/index.js";
import { RETAIN_DAYS } from "./offboarding/index.js";
import type { OffboardProvider } from "./offboarding/types.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { MemoryMailer } from "./testing/mailer.js";
import { workspaceBlobKey } from "./workspace-sync/keys.js";

/**
 * Offboarding (KOBE-28, D12) against a real Postgres: a removed or deactivated member's sandbox is
 * destroyed at once (ac-1), the workspace stays exportable by a team admin for 30 days (ac-2),
 * then a sweep deletes the volume and the workspace copy unless a legal hold covers the member
 * (ac-3). Every step is audited.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const PREFIX = "kobe/";
const WHO = ["owner", "tadmin", "bob", "carol", "dan", "erin", "frank", "gina"] as const;
type Person = (typeof WHO)[number];

class FakeProvider implements OffboardProvider {
  readonly destroyed: string[] = [];
  readonly deletedVolumes: string[] = [];
  failDestroy = false;
  failDelete = false;

  async destroySandbox(_team: unknown, userId: string) {
    if (this.failDestroy) throw new Error("Kubernetes API unavailable");
    this.destroyed.push(userId);
    return { sandboxId: randomUUID(), pvc: `workspace-u-${userId}` };
  }

  async deleteVolume(_team: unknown, pvc: string) {
    if (this.failDelete) throw new Error("Kubernetes API unavailable");
    this.deletedVolumes.push(pvc);
  }
}

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let admin: pg.Client;
const objects = new MemoryObjects();
const provider = new FakeProvider();
const ids = Object.fromEntries(WHO.map((w) => [w, ""])) as Record<Person, string>;
let as: Record<Person, TestBrowser>;
let teamId = "";

const email = (who: Person) => `${who}@offboarding.test`;
const FILES: Record<string, string> = {
  "notes/plan.md": "# Plan\nship it\n",
  "data/report.csv": "a,b\n1,2\n",
};

async function seedWorkspace(userId: string): Promise<void> {
  await withTeam(deps.database.db, teamId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc)
      VALUES (${teamId}, ${userId}, ${randomUUID()}, 'running', ${`workspace-u-${userId}`})`);
    const bytes = Object.values(FILES).reduce((n, c) => n + Buffer.byteLength(c), 0);
    await tx.execute(sql`
      INSERT INTO workspace_sync (team_id, user_id, head_rev, live_files, live_bytes, blob_count, blob_bytes)
      VALUES (${teamId}, ${userId}, 2, 2, ${bytes}, 2, ${bytes})`);
    let rev = 0;
    for (const [path, content] of Object.entries(FILES)) {
      const sha = createHash("sha256").update(content).digest("hex");
      const key = workspaceBlobKey(PREFIX, { teamId, userId }, sha);
      objects.objects.set(key, Buffer.from(content));
      await tx.execute(sql`
        INSERT INTO workspace_blobs (team_id, user_id, sha256, size)
        VALUES (${teamId}, ${userId}, ${sha}, ${Buffer.byteLength(content)})`);
      await tx.execute(sql`
        INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
        VALUES (${teamId}, ${userId}, ${path}, ${++rev}, ${sha}, ${key},
                ${Buffer.byteLength(content)}, ${Date.now()}, 'sandbox')`);
    }
  });
}

const rowOf = async (userId: string) =>
  (
    await admin.query(
      `SELECT state, pvc, retain_until, extract(epoch FROM retain_until - now()) / 86400 AS days
         FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    )
  ).rows[0] as
    | { state: string; pvc: string | null; retain_until: Date | null; days: string | null }
    | undefined;

const auditOf = async (action: string, userId: string) =>
  (
    await admin.query(
      `SELECT actor_id, actor_kind, target FROM audit_log
        WHERE action = $1 AND team_id = $2 AND target->>'userId' = $3 ORDER BY seq`,
      [action, teamId, userId],
    )
  ).rows;

const workspaceRows = async (userId: string) =>
  Number(
    (
      await admin.query(
        `SELECT (SELECT count(*) FROM workspace_files WHERE team_id = $1 AND user_id = $2)
              + (SELECT count(*) FROM workspace_blobs WHERE team_id = $1 AND user_id = $2)
              + (SELECT count(*) FROM workspace_sync WHERE team_id = $1 AND user_id = $2) AS n`,
        [teamId, userId],
      )
    ).rows[0].n,
  );

const expire = (userId: string) =>
  admin.query(
    `UPDATE sandboxes SET retain_until = now() - interval '1 minute' WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );

/** A hold is placed and released through the two-person flow in production; the guard trigger is
 *  bypassed here only to get a hold row (the guard has its own tests, KOBE-17). */
async function setHold(userId: string | null, status: "active" | "released"): Promise<void> {
  await admin.query("SET session_replication_role = replica");
  try {
    if (status === "active") {
      await admin.query(
        `INSERT INTO legal_holds (team_id, user_id, reason, status, placed_by, approved_by, approved_at, self_approved)
         VALUES ($1, $2, 'matter 2026-28', 'active', $3, $3, now(), true)`,
        [teamId, userId, ids.owner],
      );
    } else {
      await admin.query(
        `UPDATE legal_holds SET status = 'released', release_requested_by = placed_by, release_requested_at = now(),
                release_reason = 'done', released_by = placed_by, released_at = now(), release_self_approved = true
          WHERE team_id = $1 AND status = 'active'`,
        [teamId],
      );
    }
  } finally {
    await admin.query("SET session_replication_role = DEFAULT");
  }
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-offboarding-0123",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
    blobs: { objects, prefix: PREFIX },
  });
  deps.offboarding.setProvider(provider);
  app = createApp(deps);
  for (const who of WHO) {
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      who === "owner" ? { installRole: "owner" } : {},
    );
    ids[who] = user.id;
  }
  as = Object.fromEntries(
    await Promise.all(
      WHO.map(async (w) => {
        const b = new TestBrowser(app, PUBLIC_URL);
        const res = await b.post("/api/auth/sign-in/email", {
          email: email(w),
          password: PASSWORD,
        });
        expect(res.status).toBe(200);
        return [w, b] as const;
      }),
    ),
  ) as Record<Person, TestBrowser>;
  const created = await as.owner.post("/v1/install/teams", {
    slug: "finance",
    name: "Finance",
    adminUserId: ids.tadmin,
  });
  teamId = created.json.team.id;
  for (const who of ["bob", "carol", "dan", "erin", "frank"] as const) {
    await withTeam(deps.database.db, teamId, (tx) =>
      tx.insert(teamMembers).values({ teamId, userId: ids[who], role: "member" }),
    );
  }
  for (const who of ["tadmin", "carol"] as const) {
    expect((await as[who].put("/v1/me/teams/active", { teamId })).status).toBe(200);
    as[who].team = teamId;
  }
});

afterAll(async () => {
  await deps?.close();
  await admin?.end();
  if (database) {
    const server = new pg.Client({ connectionString: testServerUrl() });
    await server.connect();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await server.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`,
        [database.appRole],
      );
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await server.end();
    await database.drop();
  }
});

describe("removal destroys the sandbox at once and keeps the volume (ac-1)", () => {
  it("destroys bob's sandbox, retains 30 days, audits as the removing admin", async () => {
    await seedWorkspace(ids.bob);
    const res = await as.tadmin.delete(`/v1/team/members/${ids.bob}`);
    expect(res.status).toBe(204);

    expect(provider.destroyed).toContain(ids.bob);
    const row = await rowOf(ids.bob);
    expect(row).toMatchObject({ state: "destroyed", pvc: `workspace-u-${ids.bob}` });
    expect(Number(row?.days)).toBeGreaterThan(RETAIN_DAYS - 0.01);
    expect(Number(row?.days)).toBeLessThanOrEqual(RETAIN_DAYS);
    const [event] = await auditOf("sandbox.offboarded", ids.bob);
    expect(event).toMatchObject({ actor_id: ids.tadmin });
    expect(event.target).toMatchObject({ trigger: "member_removed", volumeKept: true });
    // Nothing of the workspace is deleted yet.
    expect(await workspaceRows(ids.bob)).toBe(5);
    expect(provider.deletedVolumes).not.toContain(`workspace-u-${ids.bob}`);
  });

  it("still removes the member when Kubernetes is down, and the sweep finishes the job", async () => {
    await seedWorkspace(ids.erin);
    provider.failDestroy = true;
    const res = await as.tadmin.delete(`/v1/team/members/${ids.erin}`);
    provider.failDestroy = false;
    expect(res.status).toBe(204);
    expect((await rowOf(ids.erin))?.state).toBe("running");

    const summary = await deps.offboarding.sweep();
    expect(summary.offboarded).toBeGreaterThanOrEqual(1);
    expect((await rowOf(ids.erin))?.state).toBe("destroyed");
    const [event] = await auditOf("sandbox.offboarded", ids.erin);
    expect(event.target).toMatchObject({ trigger: "reconciled" });
    expect(event.actor_kind).toBe("system");
  });

  it("is idempotent", async () => {
    await expect(deps.offboarding.offboardMember(teamId, ids.bob, "member_removed")).resolves.toBe(
      "already_offboarded",
    );
    expect(await auditOf("sandbox.offboarded", ids.bob)).toHaveLength(1);
  });

  it("destroys the sandboxes of a deactivated user in every team", async () => {
    await seedWorkspace(ids.dan);
    const res = await as.owner.post(`/v1/install/users/${ids.dan}/deactivate`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.incompleteSteps ?? []).toEqual([]);
    expect((await rowOf(ids.dan))?.state).toBe("destroyed");
    const [event] = await auditOf("sandbox.offboarded", ids.dan);
    expect(event.target).toMatchObject({ trigger: "deactivated" });
  });

  it("offboards a whole team's sandboxes on team removal", async () => {
    await seedWorkspace(ids.frank);
    await expect(deps.offboarding.offboardTeam(teamId)).resolves.toBe(1);
    const [event] = await auditOf("sandbox.offboarded", ids.frank);
    expect(event.target).toMatchObject({ trigger: "team_removed" });
  });
});

describe("the team admin can export the workspace for 30 days (ac-2)", () => {
  it("lists departed members and downloads a zip of the files, audited", async () => {
    const list = await as.tadmin.get("/v1/team/offboarded");
    expect(list.status).toBe(200);
    const bob = list.json.members.find((m: { userId: string }) => m.userId === ids.bob);
    expect(bob).toMatchObject({ files: 2 });
    expect(new Date(bob.retainUntil).getTime()).toBeGreaterThan(Date.now());

    const res = await as.tadmin.get(`/v1/team/offboarded/${ids.bob}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(`workspace-${ids.bob}.zip`);
    const files = unzipSync(res.bytes);
    expect(Object.keys(files).sort()).toEqual(Object.keys(FILES).sort());
    for (const [path, content] of Object.entries(FILES)) {
      expect(Buffer.from(files[path] as Uint8Array).toString()).toBe(content);
    }
    const [event] = await auditOf("sandbox.export_downloaded", ids.bob);
    expect(event).toMatchObject({ actor_id: ids.tadmin });
    expect(event.target).toMatchObject({ files: 2 });
  });

  it("is for team admins only, and only for a departed member inside the 30 days", async () => {
    expect((await as.carol.get(`/v1/team/offboarded/${ids.bob}/export`)).status).toBe(403);
    expect((await as.carol.get("/v1/team/offboarded")).status).toBe(403);
    // carol is an active member without a destroyed sandbox; a stranger has nothing at all.
    expect((await as.tadmin.get(`/v1/team/offboarded/${ids.carol}/export`)).status).toBe(404);
    expect((await as.tadmin.get(`/v1/team/offboarded/${randomUUID()}/export`)).status).toBe(404);
    expect((await as.tadmin.get(`/v1/team/offboarded/not-a-uuid/export`)).status).toBe(400);
  });

  it("is refused once the 30 days are over", async () => {
    await seedWorkspace(ids.gina);
    await deps.offboarding.offboardMember(teamId, ids.gina, "member_removed");
    await expire(ids.gina);
    expect((await as.tadmin.get(`/v1/team/offboarded/${ids.gina}/export`)).status).toBe(404);
    const list = await as.tadmin.get("/v1/team/offboarded");
    expect(list.json.members.map((m: { userId: string }) => m.userId)).not.toContain(ids.gina);
  });

  it("never offers another team's departed members", async () => {
    const other = await as.owner.post("/v1/install/teams", {
      slug: "legal",
      name: "Legal",
      adminUserId: ids.carol,
    });
    const b = new TestBrowser(app, PUBLIC_URL);
    await b.post("/api/auth/sign-in/email", { email: email("carol"), password: PASSWORD });
    await b.put("/v1/me/teams/active", { teamId: other.json.team.id });
    b.team = other.json.team.id;
    expect((await b.get("/v1/team/offboarded")).json.members).toEqual([]);
    expect((await b.get(`/v1/team/offboarded/${ids.bob}/export`)).status).toBe(404);
  });
});

describe("the sweep deletes the volume after 30 days unless a legal hold covers it (ac-3)", () => {
  it("keeps everything before the 30 days are over", async () => {
    // gina's 30 days ended in the export test above, so her volume is the only one that goes.
    const summary = await deps.offboarding.sweep();
    expect(summary.purged).toBe(1);
    expect(provider.deletedVolumes).toEqual([`workspace-u-${ids.gina}`]);
    expect(await workspaceRows(ids.bob)).toBe(5);
  });

  it("deletes the volume, the workspace rows and the objects, and audits it", async () => {
    const keys = objects.keys(`${PREFIX}teams/${teamId}/users/${ids.bob}/`);
    expect(keys).toHaveLength(2);
    await expire(ids.bob);
    const summary = await deps.offboarding.sweep();
    expect(summary).toMatchObject({ purged: expect.any(Number), failed: 0 });

    expect(provider.deletedVolumes).toContain(`workspace-u-${ids.bob}`);
    expect(objects.keys(`${PREFIX}teams/${teamId}/users/${ids.bob}/`)).toEqual([]);
    expect(await workspaceRows(ids.bob)).toBe(0);
    expect(await rowOf(ids.bob)).toMatchObject({
      state: "destroyed",
      pvc: null,
      retain_until: null,
    });
    const [event] = await auditOf("sandbox.volume_deleted", ids.bob);
    expect(event.actor_kind).toBe("system");
    expect(event.target).toMatchObject({ volumeDeleted: true, files: 2, blobs: 2 });
    // Once is enough.
    expect((await deps.offboarding.sweep()).purged).toBe(0);
    expect((await as.tadmin.get(`/v1/team/offboarded/${ids.bob}/export`)).status).toBe(404);
  });

  it("deletes nothing while a legal hold covers the member, and everything once released", async () => {
    await expire(ids.erin);
    await setHold(ids.erin, "active");
    const held = await deps.offboarding.sweep();
    expect(held.held).toBeGreaterThanOrEqual(1);
    expect(provider.deletedVolumes).not.toContain(`workspace-u-${ids.erin}`);
    expect(await workspaceRows(ids.erin)).toBe(5);
    expect(objects.keys(`${PREFIX}teams/${teamId}/users/${ids.erin}/`)).toHaveLength(2);
    expect(await auditOf("sandbox.volume_deleted", ids.erin)).toHaveLength(0);

    await setHold(null, "released");
    await deps.offboarding.sweep();
    expect(provider.deletedVolumes).toContain(`workspace-u-${ids.erin}`);
    expect(await workspaceRows(ids.erin)).toBe(0);
  });

  it("a team-wide hold also keeps it", async () => {
    await expire(ids.dan);
    await setHold(null, "active");
    await deps.offboarding.sweep();
    expect(provider.deletedVolumes).not.toContain(`workspace-u-${ids.dan}`);
    await setHold(null, "released");
  });

  it("retries after a Kubernetes failure without losing the workspace copy", async () => {
    provider.failDelete = true;
    const failed = await deps.offboarding.sweep();
    provider.failDelete = false;
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(await workspaceRows(ids.dan)).toBe(5);
    await deps.offboarding.sweep();
    expect(provider.deletedVolumes).toContain(`workspace-u-${ids.dan}`);
    expect(await workspaceRows(ids.dan)).toBe(0);
  });
});

describe("a returning member gets a new sandbox", () => {
  it("drops the retained volume (S3 copy stays) and lets the wake go on", async () => {
    const userId = ids.frank;
    expect(await rowOf(userId)).toMatchObject({ state: "destroyed" });
    await expect(deps.offboarding.reinstate({ teamId, userId })).resolves.toBe(true);
    expect(provider.deletedVolumes).toContain(`workspace-u-${userId}`);
    expect(await rowOf(userId)).toBeUndefined();
    expect(objects.keys(`${PREFIX}teams/${teamId}/users/${userId}/`)).toHaveLength(2);
    // A member with no offboarded sandbox may simply wake.
    await expect(deps.offboarding.reinstate({ teamId, userId })).resolves.toBe(true);
  });

  it("is refused while a legal hold covers the member (the volume must stay)", async () => {
    const userId = ids.carol;
    await seedWorkspace(userId);
    await deps.offboarding.offboardMember(teamId, userId, "deactivated");
    await setHold(userId, "active");
    await expect(deps.offboarding.reinstate({ teamId, userId })).resolves.toBe(false);
    expect((await rowOf(userId))?.state).toBe("destroyed");
    await setHold(null, "released");
  });
});

describe("waking an offboarded sandbox (KOBE-25 seam)", () => {
  const wakeProvider = {
    woken: [] as string[],
    async wakeSandbox(_team: unknown, userId: string) {
      this.woken.push(userId);
      return {
        resumed: false,
        handle: {
          sandboxId: randomUUID(),
          namespace: "kobe-team-finance",
          claimName: `u-${userId}`,
          sandboxName: `u-${userId}`,
          state: "running" as const,
        },
      };
    },
    async hibernateSandbox() {
      return "not_found" as const;
    },
  };
  const lifecycle = (reinstate: boolean) =>
    createSandboxLifecycle({
      db: deps.database.db,
      provider: wakeProvider,
      idleMinutes: 15,
      ...(reinstate ? { reinstate: (t) => deps.offboarding.reinstate(t) } : {}),
    });

  it("refuses without offboarding wired in, and starts a new sandbox once the member is back", async () => {
    const userId = ids.carol;
    expect((await rowOf(userId))?.state).toBe("destroyed");
    await expect(lifecycle(false).waker.wake({ teamId, userId })).rejects.toThrow(/offboarded/);
    expect(wakeProvider.woken).toEqual([]);

    await lifecycle(true).waker.wake({ teamId, userId });
    expect(wakeProvider.woken).toEqual([userId]);
    expect(await rowOf(userId)).toMatchObject({ state: "running", retain_until: null });
    expect(provider.deletedVolumes).toContain(`workspace-u-${userId}`);
  });
});

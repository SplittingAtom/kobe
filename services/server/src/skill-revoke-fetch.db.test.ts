import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import { validateZipBundle } from "./skills/bundle.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { retireVersion } from "./skills/registry/retire.js";
import { skillSandboxRoutes } from "./skills/sandbox-routes.js";
import { sha256Hex } from "./skills/storage.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import type { AuthResult, SandboxAuthenticator } from "./workspace-sync/auth.js";

/**
 * KOBE-340 ac-2 (SK31): Revoke stops a running version at the next fetch, in two teams at once,
 * and no later run loads it; Unrevoke restores it. Each team installed the catalog skill Required
 * (it loads in every run, also without an agent) and has a run holding it open in its sandbox.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
const f = new RunFixture();
const NAME = "revoke-fetch";
let skillId = "";
let hash = "";
let one: RunWorld;
let two: RunWorld;

beforeAll(async () => {
  await f.setup({ blobs });
  one = await f.world();
  two = await f.world();
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(`---\nname: ${NAME}\ndescription: Fetch me. Use it.\n---\n# Fetch\n`),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  hash = sha256Hex(b.zip);
  const key = await ensureObject(blobs, b.zip, hash);
  const s = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'F.') RETURNING id`,
    [NAME],
  );
  skillId = s.rows[0]?.id as string;
  const ver = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, manifest, provenance, source, scan, verdict, state,
       submitted_by, reviewed_by, approved_at)
     VALUES ($1, '1.0.0', 1, $2, $3, $4, $5, '{}', '{}', '{}', '{"findings": []}', 'pass',
       'approved', $6, $7, now())
     RETURNING id`,
    [skillId, hash, b.packageHash, key, b.zip.length, one.owner.id, two.owner.id],
  );
  for (const w of [one, two])
    await f.fx.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access,
         installed_by)
       VALUES ($1, $2, $3, 'pinned', 'required', $4)`,
      [w.team, skillId, ver.rows[0]?.id, w.owner.id],
    );
}, 120_000);

afterAll(async () => {
  await f.teardown();
});

/** A run held open in the world's sandbox, and how that sandbox fetches a bundle. */
async function held(w: RunWorld) {
  const ws = await f.connect(w, 0);
  ws.sb.autoAnswer = false;
  const run = await f.message(w.owner, await f.thread(w.owner), "hello");
  const start = await ws.started(run);
  const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
    `SELECT sandbox_id FROM sandbox_run_leases WHERE run_id = $1`,
    [run],
  );
  const result: AuthResult = {
    ok: true,
    caller: { sandboxId: rows[0]?.sandbox_id as string, teamId: w.team, userId: w.owner.id },
  };
  const app = skillSandboxRoutes({
    db: f.fx.db,
    blobs,
    authenticate: Object.assign(() => Promise.resolve(result), {
      forget() {},
    }) as SandboxAuthenticator,
    log: { error() {}, warn() {} },
  });
  return {
    run,
    bundles: (start.config?.skill_bundles ?? []).map((x) => x.sha256),
    fetch: async () => (await app.request(`/${hash}`)).status,
    finish: async () => {
      ws.reply(start, "ok");
      await f.until(w.team, run, "completed");
      ws.kill();
    },
  };
}

const omitted = async (w: RunWorld, run: string) =>
  (await f.events(w.team, run))
    .filter((e) => e.type === "context.omitted")
    .flatMap((e) => (e.payload as { items?: { name: string }[] }).items ?? [])
    .map((i) => i.name);

const act = (what: "revoke" | "unrevoke") =>
  runWithAuditContext(
    { actor: { kind: "user", id: one.owner.id }, ip: null, userAgent: null },
    () =>
      retireVersion(f.fx.db, {
        skillId,
        semver: "1.0.0",
        act: what,
        actor: { userId: one.owner.id, siteRole: "admin" },
      }),
  );

describe("Revoke reaches running sessions in every team (ac-2)", () => {
  it("stops the next fetch in two teams; later runs leave it out; Unrevoke restores it", async () => {
    const before = [await held(one), await held(two)];
    for (const r of before) {
      expect(r.bundles).toContain(hash);
      expect(await r.fetch()).toBe(200);
    }
    expect((await act("revoke")).ok).toBe(true);
    // The runs already started can't fetch it any more: the next fetch stops it.
    for (const r of before) expect(await r.fetch()).toBe(404);
    for (const r of before) await r.finish();

    const after = [await held(one), await held(two)];
    for (const [i, r] of after.entries()) {
      expect(r.bundles).not.toContain(hash);
      expect(await omitted(i === 0 ? one : two, r.run)).toContain(NAME);
      await r.finish();
    }

    expect((await act("unrevoke")).ok).toBe(true);
    const restored = [await held(one), await held(two)];
    for (const r of restored) {
      expect(r.bundles).toContain(hash);
      expect(await r.fetch()).toBe(200);
      await r.finish();
    }
  });
});

import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KOBE_SKILL_NAMES } from "@kobe/protocol";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSyncOnce } from "./skills/default-sync.js";
import { KOBE_PACKAGES_DIR, loadKobePackages, readKobePackage } from "./skills/kobe-packages.js";
import { catalogObjectKey, seedKobeSkills } from "./skills/kobe-seed.js";
import { skillSandboxRoutes } from "./skills/sandbox-routes.js";
import { sha256Hex } from "./skills/storage.js";
import { RawBody } from "./testing/browser.js";
import { catalogSeed } from "./testing/catalog-seed.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { MemoryMailer } from "./testing/mailer.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import type { AuthResult, SandboxAuthenticator } from "./workspace-sync/auth.js";

/**
 * KOBE-317 (SK4, U38): the built-ins become Kobe-published Default catalog skills. A site that
 * ran them from the sandbox image upgrades: the seed publishes the seven at every start (approved,
 * no person, tagged Default, bytes in the object store), the Default sync installs them in every
 * team (On by default, Track within major, by Kobe, no notices), and a run that named a built-in
 * keeps getting the same content as a bundle, also before the sync reaches its team.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
const f = new RunFixture();
const ANY = { "if-match": "*" };
const quiet = { info() {}, warn() {}, error() {} };
const unique = () => randomUUID().slice(0, 8);

const seed = (packages?: Parameters<typeof seedKobeSkills>[0]["packages"]) =>
  seedKobeSkills({ db: f.fx.db, blobs, log: quiet, ...(packages ? { packages } : {}) });
const mailer = new MemoryMailer();
const sync = async () => {
  const deps = {
    database: f.fx.replica(0).deps.database,
    log: quiet,
    mailer,
    publicUrl: "https://kobe.test",
  };
  while (((await defaultSyncOnce(deps)) ?? 0) > 0);
};

const runtimeHashes = async () =>
  Object.fromEntries((await loadKobePackages()).map((p) => [p.name, sha256Hex(p.bundle.zip)]));

async function pinnedThread(p: Person, skills: string[] | { exclusive: string[] }) {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `A ${unique()}`, skills },
    prompt: "You use skills.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  expect((await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(201);
  const thread = await b.post("/v1/threads", { agent_id: id });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  return thread.json.thread_id as string;
}

async function startOf(w: RunWorld, thread: string, hold = false) {
  const ws = await f.connect(w, 0);
  if (hold) ws.sb.autoAnswer = false;
  const run = await f.message(w.owner, thread, "hello");
  const start = await ws.started(run);
  if (!hold) {
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
    ws.kill();
  }
  return { run, ws, config: start.config ?? {} };
}

const omissionsOf = async (w: RunWorld, run: string) =>
  (await f.events(w.team, run))
    .filter((e) => e.type === "context.omitted")
    .flatMap((e) => (e.payload as { items?: { name: string; reason: string }[] }).items ?? []);

let upgraded: RunWorld;
let optedOut: RunWorld;
let ownPdf: RunWorld;
let requiredPdf: RunWorld;
let ownRequiredHash = "";

const zipNamed = (name: string, note = "ours") =>
  new RawBody(
    zipSync({ "SKILL.md": strToU8(`---\nname: ${name}\ndescription: Ours\n---\n${note}\n`) }),
    "application/zip",
  );

beforeAll(async () => {
  await f.setup({ blobs });
  // Teams of the site before the upgrade.
  upgraded = await f.world();
  optedOut = await f.world();
  ownPdf = await f.world();
  requiredPdf = await f.world();
  // Team skills named like a built-in, made before the names were reserved (review-317 S4).
  const rows = catalogSeed(() => f.fx.admin);
  const own = await rows.teamSkill(ownPdf.team, ownPdf.owner.id, "pdf", "default_on");
  await rows.addVersion(ownPdf.team, ownPdf.owner.id, own, "pdf", 1);
  const req = await rows.teamSkill(requiredPdf.team, requiredPdf.owner.id, "pdf", "required");
  ownRequiredHash = await rows.addVersion(requiredPdf.team, requiredPdf.owner.id, req, "pdf", 1);
}, 120_000);
afterAll(async () => {
  await f.teardown();
});

describe("the seed (ac-1)", () => {
  it("publishes the seven as approved Kobe catalog versions with no person, tagged Default", async () => {
    const results = await seed();
    expect(results.map((r) => [r.name, r.action])).toEqual(
      KOBE_SKILL_NAMES.map((n) => [n, "created"]),
    );
    const { rows } = await f.fx.admin.query(
      `SELECT s.name, s.publisher::text AS sp, v.publisher::text AS vp, v.semver, v.state::text,
         v.submitted_by, v.reviewed_by, v.runtime_hash, v.runtime_storage_key, v.verdict::text,
         v.provenance ->> 'publisher' AS prov,
         EXISTS (SELECT 1 FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
           WHERE st.skill_id = s.id AND t.name = 'default' AND st.by_kobe AND st.added_by IS NULL) AS dflt
       FROM registry_skills s JOIN registry_versions v ON v.skill_id = s.id ORDER BY s.name`,
    );
    const hashes = await runtimeHashes();
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r, r.name).toMatchObject({
        sp: "kobe",
        vp: "kobe",
        semver: "1.0.0",
        state: "approved",
        submitted_by: null,
        reviewed_by: null,
        runtime_hash: hashes[r.name],
        runtime_storage_key: catalogObjectKey("kobe/", hashes[r.name] as string),
        prov: "kobe",
        dflt: true,
      });
      expect(["pass", "caution"]).toContain(r.verdict);
      const stored = objects.objects.get(r.runtime_storage_key as string);
      expect(stored && createHash("sha256").update(stored).digest("hex")).toBe(r.runtime_hash);
    }
    const audits = await f.fx.admin.query(
      `SELECT actor_kind, actor_id, team_id, target ->> 'name' AS name FROM audit_log
       WHERE action = 'skill.kobe.published' ORDER BY seq`,
    );
    expect(audits.rows).toHaveLength(7);
    expect(audits.rows.every((a) => a.actor_kind === "system" && a.actor_id === null)).toBe(true);
    const jobs = await f.fx.admin.query(
      `SELECT kind, by_kobe, requested_by FROM skill_default_syncs`,
    );
    expect(jobs.rows).toEqual(
      Array.from({ length: 7 }, () => ({ kind: "add", by_kobe: true, requested_by: null })),
    );
  });

  it("an agent naming a former built-in gets the same content before the sync reaches its team", async () => {
    const hashes = await runtimeHashes();
    const thread = await pinnedThread(upgraded.owner, ["pdf", "charts"]);
    const { run, ws, config } = await startOf(upgraded, thread, true);
    expect(config.skills).toEqual(["pdf", "charts"]);
    expect(config.skill_bundles?.map((b) => [b.name, b.sha256])).toEqual([
      ["pdf", hashes.pdf],
      ["charts", hashes.charts],
    ]);
    expect(config).not.toHaveProperty("builtin_skills");
    // The sandbox fetches it like any bundle, byte for byte.
    const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
      `SELECT sandbox_id FROM sandbox_run_leases WHERE run_id = $1`,
      [run],
    );
    const result: AuthResult = {
      ok: true,
      caller: {
        sandboxId: rows[0]?.sandbox_id as string,
        teamId: upgraded.team,
        userId: upgraded.owner.id,
      },
    };
    const app = skillSandboxRoutes({
      db: f.fx.db,
      blobs,
      authenticate: Object.assign(() => Promise.resolve(result), {
        forget() {},
      }) as SandboxAuthenticator,
      log: { error() {}, warn() {} },
    });
    const res = await app.request(`/${hashes.pdf}`);
    expect(res.status).toBe(200);
    const pdf = (await loadKobePackages()).find((p) => p.name === "pdf");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(pdf?.bundle.zip ?? []))).toBe(
      true,
    );
    ws.kill();
  });

  it("a restart changes nothing: no new version, audit or sync", async () => {
    const results = await seed();
    expect(results.every((r) => r.action === "unchanged")).toBe(true);
    const counts = await f.fx.admin.query(
      `SELECT (SELECT count(*) FROM registry_versions)::int AS versions,
         (SELECT count(*) FROM skill_default_syncs)::int AS jobs,
         (SELECT count(*) FROM audit_log WHERE action = 'skill.kobe.published')::int AS audits`,
    );
    expect(counts.rows[0]).toEqual({ versions: 7, jobs: 7, audits: 7 });
  });

  it("re-writes a Kobe object that went missing", async () => {
    const hashes = await runtimeHashes();
    const key = catalogObjectKey("kobe/", hashes.xlsx as string);
    objects.objects.delete(key);
    await seed();
    expect(objects.objects.has(key)).toBe(true);
  });
});

describe("the Default sync installs them in every team (ac-1)", () => {
  it("every team gets all seven, On by default, Track within major, by Kobe, and no notice", async () => {
    // A team opts out of pdf before the sync reaches it: the opt-out is kept.
    await f.fx.admin.query(
      `INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by)
       SELECT $1, id, $2 FROM registry_skills WHERE name = 'pdf'`,
      [optedOut.team, optedOut.owner.id],
    );
    await sync();
    const installs = await f.fx.admin.query(
      `SELECT i.team_id, s.name, i.access::text, i.pin_mode::text, i.origin::text, i.by_kobe,
         i.installed_by
       FROM team_skill_installs i JOIN registry_skills s ON s.id = i.skill_id`,
    );
    const of = (team: string) =>
      installs.rows
        .filter((r) => r.team_id === team)
        .map((r) => r.name)
        .sort();
    expect(of(upgraded.team)).toEqual([...KOBE_SKILL_NAMES].sort());
    expect(of(optedOut.team)).toEqual([...KOBE_SKILL_NAMES].filter((n) => n !== "pdf").sort());
    // Its own pdf keeps the name (SK27 name clash): the sync skipped pdf there.
    expect(of(ownPdf.team)).toEqual([...KOBE_SKILL_NAMES].filter((n) => n !== "pdf").sort());
    for (const r of installs.rows)
      expect(r).toMatchObject({
        access: "default_on",
        pin_mode: "within_major",
        origin: "default_tag",
        by_kobe: true,
        installed_by: null,
      });
    expect(mailer.sent).toEqual([]);
    // A team created after the upgrade has them at once.
    const fresh = await f.world();
    const { rows } = await f.fx.admin.query(
      `SELECT count(*)::int AS n FROM team_skill_installs WHERE team_id = $1 AND by_kobe`,
      [fresh.team],
    );
    expect(rows[0]?.n).toBe(7);
  });

  it("their install listing names no installer", async () => {
    const res = await f.on(0, upgraded.owner).get("/v1/team/skills/installs");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const pdf = (res.json.installs as { name: string; installedBy: string | null }[]).find(
      (i) => i.name === "pdf",
    );
    expect(pdf).toMatchObject({ installedBy: null, isDefault: true, origin: "default_tag" });
  });
});

describe("runs after the upgrade (ac-3)", () => {
  it("an agent that names none still gets them On by default; an exclusive one only its own", async () => {
    const plain = await startOf(upgraded, await pinnedThread(upgraded.owner, []));
    expect([...(plain.config.skills ?? [])].sort()).toEqual([...KOBE_SKILL_NAMES].sort());
    const only = await startOf(
      upgraded,
      await pinnedThread(upgraded.owner, { exclusive: ["docx"] }),
    );
    expect(only.config.skills).toEqual(["docx"]);
  });

  it("a named pdf is Kobe's even where the team has its own pdf; an opted-out team is told", async () => {
    const hashes = await runtimeHashes();
    const own = await startOf(ownPdf, await pinnedThread(ownPdf.owner, ["pdf"]));
    expect(own.config.skill_bundles?.find((b) => b.name === "pdf")?.sha256).toBe(hashes.pdf);
    const out = await startOf(optedOut, await pinnedThread(optedOut.owner, ["pdf"]));
    expect(out.config.skills ?? []).not.toContain("pdf");
    expect(await omissionsOf(optedOut, out.run)).toContainEqual(
      expect.objectContaining({ name: "pdf", reason: "not_installed" }),
    );
  });
});

describe("reserved names in teams (review-317 S4)", () => {
  it("no new team or personal skill takes a Kobe name; one made before keeps its versions", async () => {
    const w = await f.world();
    for (const scope of ["team", "personal"]) {
      const res = await f.on(0, w.owner).post(`/v1/skills?scope=${scope}`, zipNamed("xlsx"));
      expect(res.status, scope).toBe(409);
      expect(res.json.code).toBe("reserved_name");
    }
    const next = await f.on(0, ownPdf.owner).post("/v1/skills?scope=team", zipNamed("pdf", "v2"));
    expect(next.status, JSON.stringify(next.json)).toBe(201);
  });

  it("a team's own Required pdf wins over Kobe's, with a notice to an agent naming pdf", async () => {
    const hashes = await runtimeHashes();
    const { run, config } = await startOf(
      requiredPdf,
      await pinnedThread(requiredPdf.owner, ["pdf"]),
    );
    const pdfs = (config.skill_bundles ?? []).filter((b) => b.name === "pdf");
    expect(pdfs.map((b) => b.sha256)).toEqual([ownRequiredHash]);
    expect(pdfs[0]?.sha256).not.toBe(hashes.pdf);
    expect(await omissionsOf(requiredPdf, run)).toContainEqual(
      expect.objectContaining({ name: "pdf", reason: "shadowed" }),
    );
  });
});

describe("a run.start queued before the upgrade (review-317 S1)", () => {
  it("still listing builtin_skills fails visibly instead of starting without them", async () => {
    const w = await f.world();
    const thread = await pinnedThread(w.owner, ["pdf"]);
    // Queued with no sandbox connected yet, then rewritten as a pre-317 server stored it.
    const run = await f.message(w.owner, thread, "hello");
    await expect
      .poll(
        async () =>
          (
            await f.fx.admin.query(
              `SELECT status::text FROM sandbox_commands WHERE run_id = $1 AND kind = 'run.start'`,
              [run],
            )
          ).rows.map((r) => r.status),
        { timeout: 10_000 },
      )
      .toEqual(["pending"]);
    const queued = await f.fx.admin.query(
      `UPDATE sandbox_commands
         SET frame = jsonb_set(frame, '{config,builtin_skills}', '["pdf"]'::jsonb)
       WHERE run_id = $1 AND kind = 'run.start' AND status = 'pending' RETURNING id`,
      [run],
    );
    expect(queued.rowCount).toBe(1);
    const ws = await f.connect(w, 0, ["skill_bundles", "builtin_skills"]);
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)?.payload).toMatchObject({
      error: {
        code: "queued_before_upgrade",
        message:
          "This message was queued while Kobe was being upgraded and couldn't start. Send it again.",
      },
    });
    expect(ws.starts().map((x) => x.run_id)).not.toContain(run);
    ws.kill();
  });
});

describe("versions only rise", () => {
  async function variant(name: string, semver: string, extra?: Record<string, string>) {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-variant-"));
    await cp(path.join(KOBE_PACKAGES_DIR, name), path.join(dir, name), { recursive: true });
    const yaml = path.join(dir, name, "kobe.skill.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace("version: 1.0.0", `version: ${semver}`),
    );
    const md = path.join(dir, name, "SKILL.md");
    await writeFile(md, `${await readFile(md, "utf8")}\nChanged in ${semver}.\n`);
    for (const [file, body] of Object.entries(extra ?? {}))
      await writeFile(path.join(dir, name, file), body);
    try {
      return await readKobePackage(dir, name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("refuses new bytes under a held semver or a lower one, and Block packages", async () => {
    expect((await seed([await variant("docx", "1.0.0")]))[0]).toMatchObject({
      action: "refused",
      reason: "version_reused",
    });
    expect((await seed([await variant("docx", "0.9.0")]))[0]).toMatchObject({
      action: "refused",
      reason: "version_not_newer",
    });
    expect(
      (await seed([await variant("docx", "1.2.0", { "tool.exe": "MZ\u0000binary" })]))[0],
    ).toMatchObject({ action: "refused", reason: "scan_block" });
  });

  it("a raised minor is published and reaches Default installs through Track within major", async () => {
    const next = await variant("docx", "1.1.0");
    expect((await seed([next]))[0]).toMatchObject({ action: "published" });
    const { config } = await startOf(upgraded, await pinnedThread(upgraded.owner, ["docx"]));
    expect(config.skill_bundles?.find((b) => b.name === "docx")?.sha256).toBe(
      sha256Hex(next.bundle.zip),
    );
    // The add it queued fills teams only: a team's install is not changed.
    const jobs = await f.fx.admin.query(
      `SELECT count(*)::int AS n FROM skill_default_syncs j JOIN registry_skills s ON s.id = j.skill_id
       WHERE s.name = 'docx' AND j.by_kobe`,
    );
    expect(jobs.rows[0]?.n).toBe(2);
  });
});

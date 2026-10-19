import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { loadCatalogFacts } from "./runs/catalog-facts.js";
import { validateZipBundle } from "./skills/bundle.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { sha256Hex } from "./skills/storage.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-337 (SK25, SK31): team installs, pins and updates. Each pin mode and access mode, and the
 * version runs load; Update available with changelog, diff and eval delta; Move pin and Roll back,
 * audited; Track within major never takes a new major; withdrawn and revoked versions can't be
 * installed; and another team's install is untouched by all of it.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
let h: Harness;
const ids = { adminA: "", builderA: "", adminB: "", maintainer: "" };
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
let skillId = "";
const NAME = "quarterly-report";

/** One published version with its bytes stored; `pass`/`lift`: its authoritative card. */
async function version(
  semver: string,
  seq: number,
  state: string,
  card?: { pass: number; lift: number },
) {
  const manifest = `apiVersion: kobe.dev/skill/v1\nname: ${NAME}\nversion: ${semver}\nsummary: Reports.\nlicense: MIT\nchangelog: What ${semver} changed.\n`;
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(
        `---\nname: ${NAME}\ndescription: Builds reports. Use it for reports.\n---\n# Report\n\nVersion ${semver}.\n`,
      ),
      "kobe.skill.yaml": strToU8(manifest),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
  const published = ["approved", "deprecated", "withdrawn", "revoked"].includes(state);
  await h.admin.query(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by, state, reviewed_by, approved_at, authoritative_scorecard)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', '{}', '{"findings": []}', 'pass', $10,
       $11::registry_version_state, $12, $13::timestamptz, $14::jsonb)`,
    [
      skillId,
      semver,
      seq,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      JSON.stringify(b.manifest),
      ids.maintainer,
      state,
      published ? ids.adminB : null,
      published ? new Date().toISOString() : null,
      card ? JSON.stringify({ passRateWith: card.pass, lift: card.lift, cases: 5 }) : null,
    ],
  );
}

beforeAll(async () => {
  h = await openHarness({ blobs });
  ids.maintainer = await h.createUser("maintainer@installs.test");
  for (const who of ["adminA", "builderA", "adminB"] as Who[])
    ids[who] = await h.createUser(`${who}@installs.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'ta', 'A'), ($2, 'tb', 'B')`,
    [teamA, teamB],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'),
       ($1, $3, 'builder'), ($4, $5, 'team_admin')`,
    [teamA, ids.adminA, ids.builderA, teamB, ids.adminB],
  );
  for (const who of ["adminA", "builderA", "adminB"] as Who[]) {
    as[who] = await h.signIn(`${who}@installs.test`);
    const team = who === "adminB" ? teamB : teamA;
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  const skill = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'Reports.') RETURNING id`,
    [NAME],
  );
  skillId = skill.rows[0]?.id as string;
  await version("0.9.0", 1, "revoked");
  await version("1.0.0", 2, "approved", { pass: 0.7, lift: 0.1 });
  await version("1.1.0", 3, "approved", { pass: 0.8, lift: 0.2 });
  await version("1.2.0", 4, "withdrawn");
  await version("2.0.0", 5, "approved", { pass: 0.9, lift: 0.4 });
});

afterAll(async () => {
  await h?.close();
});

const install = (who: Who, body: object) =>
  as[who].request("PUT", `/v1/team/skills/installs/${skillId}`, body);

/** What a run in the team loads from the install, as run start resolves it. */
async function loaded(team: string, userId: string) {
  const facts = await withTeam(h.deps.database.db, team, (tx) =>
    loadCatalogFacts(tx, { teamId: team, userId, namedCatalog: [] }),
  );
  return {
    required: facts.required.map((r) => r.semver),
    offered: facts.offered.map((r) => r.semver),
  };
}

const audits = async (action: string) =>
  (
    await h.admin.query<{ team_id: string; target: Record<string, unknown> }>(
      `SELECT team_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

describe("install with each pin and access mode (ac-1, ac-3)", () => {
  it("runs load the version the pin picks; within major never takes 2.0.0", async () => {
    const cases = [
      ["pinned", "1.0.0"],
      ["within_major", "1.1.0"], // 1.2.0 is withdrawn: tracking skips it
      ["latest", "2.0.0"],
    ] as const;
    for (const [pinMode, runs] of cases) {
      const r = await install("adminA", { version: "1.0.0", pinMode, access: "default_on" });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(await loaded(teamA, ids.adminA), pinMode).toEqual({ required: [], offered: [runs] });
    }
    expect(
      (await install("adminA", { version: "1.0.0", pinMode: "pinned", access: "required" })).status,
    ).toBe(200);
    expect(await loaded(teamA, ids.adminA)).toEqual({ required: ["1.0.0"], offered: [] });
    for (const access of ["hidden", "available"]) {
      expect(
        (await install("adminA", { version: "1.0.0", pinMode: "pinned", access })).status,
      ).toBe(200);
      expect(await loaded(teamA, ids.adminA), access).toEqual({ required: [], offered: [] });
    }
    // A Builder never sets Required, nor changes a Team admin's install.
    const b = await install("builderA", {
      version: "1.0.0",
      pinMode: "pinned",
      access: "required",
    });
    expect(b.status).toBe(403);
    // Withdrawn and revoked versions are not installable.
    for (const version of ["1.2.0", "0.9.0"]) {
      const r = await install("adminA", { version, pinMode: "pinned", access: "available" });
      expect([r.status, r.json.code], version).toEqual([409, "not_installable"]);
    }
  });
});

describe("updates, Move pin and Roll back (ac-2, ac-3, ac-4)", () => {
  it("shows updates with changelog, eval delta and diff; moves and rolls back, audited; team B untouched", async () => {
    expect(
      (await install("adminA", { version: "1.0.0", pinMode: "within_major", access: "default_on" }))
        .status,
    ).toBe(200);
    expect(
      (await install("adminB", { version: "1.0.0", pinMode: "pinned", access: "default_on" }))
        .status,
    ).toBe(200);

    const u = await as.adminA.get(`/v1/team/skills/installs/${skillId}/updates`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json).toMatchObject({
      pinMode: "within_major",
      pinned: { semver: "1.0.0" },
      running: { semver: "1.1.0" },
      rollbackTo: null,
    });
    // Within major runs 1.1.0 already; 2.0.0 is a major it never takes by itself.
    expect(u.json.updates).toEqual([
      expect.objectContaining({
        semver: "2.0.0",
        major: true,
        automatic: false,
        changelog: "What 2.0.0 changed.",
        evalDelta: { passRate: 0.1, lift: 0.2 },
      }),
    ]);
    const diff = await as.adminA.get(`/v1/team/skills/installs/${skillId}/diff?to=2.0.0`);
    expect(diff.status, JSON.stringify(diff.json)).toBe(200);
    expect((diff.json.files as { path: string; status: string }[])[0]).toMatchObject({
      path: "SKILL.md",
      status: "changed",
    });

    // Move pin to 2.0.0 (an explicit act takes the major), then Roll back.
    const moved = await as.adminA.post(`/v1/team/skills/installs/${skillId}/move`, {
      version: "2.0.0",
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(await loaded(teamA, ids.adminA)).toEqual({ required: [], offered: ["2.0.0"] });
    expect((await audits("skill.catalog.pin_moved")).at(-1)).toMatchObject({
      team_id: teamA,
      target: { from: "1.0.0", to: "2.0.0", pinMode: "within_major" },
    });
    const back = await as.adminA.post(`/v1/team/skills/installs/${skillId}/rollback`, {});
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(await loaded(teamA, ids.adminA)).toEqual({ required: [], offered: ["1.1.0"] });
    expect((await audits("skill.catalog.rolled_back")).at(-1)).toMatchObject({
      team_id: teamA,
      target: { from: "2.0.0", to: "1.0.0" },
    });
    // Moving to a withdrawn version is refused like installing it.
    const bad = await as.adminA.post(`/v1/team/skills/installs/${skillId}/move`, {
      version: "1.2.0",
    });
    expect([bad.status, bad.json.code]).toEqual([409, "not_installable"]);

    // Team B's install and runs are untouched by all of it (ac-4).
    expect(await loaded(teamB, ids.adminB)).toEqual({ required: [], offered: ["1.0.0"] });
    const bRow = await h.admin.query(
      `SELECT v.semver, i.pin_mode FROM team_skill_installs i
         JOIN registry_versions v ON v.id = i.version_id WHERE i.team_id = $1`,
      [teamB],
    );
    expect(bRow.rows).toEqual([{ semver: "1.0.0", pin_mode: "pinned" }]);
    expect(
      [
        ...(await audits("skill.catalog.pin_moved")),
        ...(await audits("skill.catalog.rolled_back")),
      ].every((a) => a.team_id === teamA),
    ).toBe(true);
    // A pinned install lists newer versions as updates it doesn't take by itself.
    const pinned = await as.adminB.get(`/v1/team/skills/installs/${skillId}/updates`);
    expect(
      (pinned.json.updates as { semver: string; automatic: boolean }[]).map((x) => [
        x.semver,
        x.automatic,
      ]),
    ).toEqual([
      ["2.0.0", false],
      ["1.1.0", false],
    ]);
  });

  it("refuses a Roll back with nothing to go back to", async () => {
    const r = await as.adminB.post(`/v1/team/skills/installs/${skillId}/rollback`, {});
    expect([r.status, r.json.code]).toEqual([409, "no_rollback"]);
  });
});

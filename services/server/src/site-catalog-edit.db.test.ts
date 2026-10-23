import { randomUUID } from "node:crypto";
import { canonicalZip } from "@kobe/protocol";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateZipBundle } from "./skills/bundle.js";
import { KOBE_PACKAGES_DIR, readKobePackage, type KobePackage } from "./skills/kobe-packages.js";
import { ensureObject, seedKobeSkills } from "./skills/kobe-seed.js";
import { runWithAuditContext } from "./audit/context.js";
import { resetToKobe } from "./skills/site-edit/kobe-detach.js";
import { sha256Hex } from "./skills/storage.js";
import { RawBody, type TestBrowser, type TestResponse } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-495: Site admins view and edit catalog skills and publish new versions made by the Site.
 * The view (versions, files, frontmatter, provenance, scan, hashes), a persistent site draft
 * (admins only, re-checked per call; If-Match revisions), Save version (validation, scan Block,
 * semver must rise, publisher `site` with the admin, audited, Default sync queued in the Default's
 * major, the publishing team's maintainers told), the Kobe seed skipping a detached skill and
 * recording the shipped version, Compare and Reset to Kobe, and the retired/blocklisted guards.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
const team = randomUUID();
let h: Harness;
const ids = { admin: "", other: "", maintainer: "", member: "" };
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
const email = (who: Who) => `${who}@site-catalog-edit.test`;
const BASE = "/v1/site/skills/catalog-skills";
const json = (r: TestResponse) => JSON.stringify(r.json);
const quiet = { info() {}, warn() {}, error() {} };
let reportId = "";

/** A maintainer-published catalog skill from `team`, its bytes in the catalog store. */
async function maintainerSkill(name: string, semver = "1.0.0"): Promise<string> {
  const skill = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'Reports.') RETURNING id`,
    [name],
  );
  const skillId = skill.rows[0]?.id as string;
  const manifest = [
    "apiVersion: kobe.dev/skill/v1",
    `name: ${name}`,
    `version: ${semver}`,
    "summary: Reports.",
    "license: Apache-2.0",
    `changelog: First.`,
  ].join("\n");
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(
        `---\nname: ${name}\ndescription: Builds reports.\n---\n# ${name}\n\nStep one.\n`,
      ),
      "kobe.skill.yaml": strToU8(`${manifest}\n`),
      "references/notes.md": strToU8("Notes.\n"),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
  await h.admin.query(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by, state, reviewed_by, approved_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, '{}', $9, '{"findings": []}', 'pass', $10,
       'approved', $11, now())`,
    [
      skillId,
      semver,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      JSON.stringify(b.manifest),
      JSON.stringify({ scope: "team", teamId: team, skillId: randomUUID(), seq: 1, semver }),
      ids.maintainer,
      ids.other,
    ],
  );
  await h.admin.query(`INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2)`, [
    skillId,
    ids.maintainer,
  ]);
  return skillId;
}

/** `p` re-numbered `semver` (its files otherwise the same, SKILL.md with a new line). */
function shippedAs(p: KobePackage, semver: string): KobePackage {
  const files = new Map(Object.entries(unzipSync(p.bundle.packageZip ?? p.bundle.zip)));
  const yaml = new TextDecoder().decode(files.get("kobe.skill.yaml"));
  files.set("kobe.skill.yaml", strToU8(yaml.replace(/^version: .*$/m, `version: ${semver}`)));
  const md = new TextDecoder().decode(files.get("SKILL.md"));
  files.set("SKILL.md", strToU8(`${md}\nShipped ${semver}.\n`));
  const valid = validateZipBundle(canonicalZip(files));
  if (!valid.ok || !valid.value.manifest) throw new Error("variant package invalid");
  return { name: p.name, semver, manifest: valid.value.manifest, bundle: valid.value };
}

const putFile = (who: Who, skillId: string, path: string, text: string | Uint8Array, rev: number) =>
  as[who].put(
    `${BASE}/${skillId}/draft/files/${path}`,
    new RawBody(text, "text/plain; charset=utf-8"),
    { "if-match": `"${rev}"` },
  );

const publish = (who: Who, skillId: string, rev: number, semver: string) =>
  as[who].request(
    "POST",
    `${BASE}/${skillId}/draft/publish`,
    { semver, changelog: `Site edit ${semver}.` },
    { "if-match": `"${rev}"` },
  );

const audits = async (action: string, skillId: string) =>
  (
    await h.admin.query<{ actor_id: string | null; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log WHERE action = $1 AND target->>'skillId' = $2 ORDER BY seq`,
      [action, skillId],
    )
  ).rows;

beforeAll(async () => {
  h = await openHarness({ blobs });
  ids.admin = await h.createUser(email("admin"), "admin");
  ids.other = await h.createUser(email("other"), "admin");
  ids.maintainer = await h.createUser(email("maintainer"));
  ids.member = await h.createUser(email("member"));
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'sce', 'SCE')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'),
       ($1, $3, 'builder'), ($1, $4, 'member')`,
    [team, ids.admin, ids.maintainer, ids.member],
  );
  for (const who of Object.keys(ids) as Who[]) {
    as[who] = await h.signIn(email(who));
    if (who !== "other")
      expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  reportId = await maintainerSkill("site-report");
}, 120_000);
afterAll(async () => {
  await h.close();
});

describe("the view (ac-1)", () => {
  it("shows a catalog skill to Site admins only: versions, files, frontmatter, hashes", async () => {
    expect((await as.member.get(`${BASE}/${reportId}`)).status).toBe(403);
    const view = await as.admin.get(`${BASE}/${reportId}`);
    expect(view.status, json(view)).toBe(200);
    expect(view.json).toMatchObject({ name: "site-report", publisher: "maintainer", kobe: null });
    const v = view.json.versions[0];
    expect(v).toMatchObject({ semver: "1.0.0", publisher: "maintainer", stored: true });
    const detail = await as.admin.get(`${BASE}/${reportId}/versions/${v.id}`);
    expect(detail.status, json(detail)).toBe(200);
    expect(detail.json.files.map((f: { path: string }) => f.path)).toEqual([
      "SKILL.md",
      "kobe.skill.yaml",
      "references/notes.md",
    ]);
    expect(detail.json.frontmatter).toMatchObject({ name: "site-report" });
    expect(detail.json.hashes.runtime).toBe(v.runtimeHash);
    const file = await as.admin.get(
      `${BASE}/${reportId}/versions/${v.id}/files/references/notes.md`,
    );
    expect(file.json).toMatchObject({
      path: "references/notes.md",
      encoding: "text",
      text: "Notes.\n",
    });
    expect((await as.member.get(`${BASE}/${reportId}/versions/${v.id}`)).status).toBe(403);
  });
});

describe("the site draft (ac-2)", () => {
  it("starts from a version, persists, and refuses non-admins and stale revisions", async () => {
    const view = await as.admin.get(`${BASE}/${reportId}`);
    const versionId = view.json.versions[0].id as string;
    expect((await as.member.post(`${BASE}/${reportId}/draft`, { versionId })).status).toBe(403);
    const started = await as.admin.post(`${BASE}/${reportId}/draft`, { versionId });
    expect(started.status, json(started)).toBe(201);
    expect(started.json.files.map((f: { path: string }) => f.path)).toContain("SKILL.md");
    const again = await as.admin.post(`${BASE}/${reportId}/draft`, { versionId });
    expect(again.json.code).toBe("draft_exists");
    const rev = started.json.draft.rev as number;
    const md = `---\nname: site-report\ndescription: Builds reports, edited by the Site.\n---\n# site-report\n\nStep two.\n`;
    const put = await putFile("other", reportId, "SKILL.md", md, rev);
    expect(put.status, json(put)).toBe(200);
    // The admin's tab still names the old revision: refused, naming who changed it.
    const stale = await putFile("admin", reportId, "SKILL.md", md, rev);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("stale_revision");
    expect((await putFile("member", reportId, "SKILL.md", md, put.json.rev)).status).toBe(403);
    // Persisted: a reload reads it back.
    const read = await as.admin.get(`${BASE}/${reportId}/draft/files/SKILL.md`);
    expect(read.text).toBe(md);
    expect((await as.admin.get(`${BASE}/${reportId}/draft`)).json.draft.rev).toBe(put.json.rev);
    // Package rules: provenance.json is Kobe's.
    const bad = await putFile("admin", reportId, "provenance.json", "{}", put.json.rev);
    expect(bad.json.code).toBe("invalid_path");
  });

  it("re-checks the Site role on every call", async () => {
    await h.admin.query(`DELETE FROM site_roles WHERE user_id = $1`, [ids.other]);
    const draft = (await as.admin.get(`${BASE}/${reportId}/draft`)).json.draft;
    expect((await putFile("other", reportId, "x.md", "x", draft.rev)).status).toBe(403);
    await h.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [ids.other]);
  });
});

describe("Save version (ac-3, ac-5)", () => {
  it("stops on a scan Block with its findings, and needs a semver above the newest", async () => {
    let rev = (await as.admin.get(`${BASE}/${reportId}/draft`)).json.draft.rev as number;
    const blocked = await putFile("admin", reportId, "lib/mod.pyc", "\u0000compiled", rev);
    expect(blocked.status, json(blocked)).toBe(200);
    rev = blocked.json.rev;
    const block = await publish("admin", reportId, rev, "1.1.0");
    expect(block.status, json(block)).toBe(422);
    expect(block.json.code).toBe("scan_block");
    expect(block.json.scan.findings.length).toBeGreaterThan(0);
    const removed = await as.admin.request(
      "DELETE",
      `${BASE}/${reportId}/draft/files/lib/mod.pyc`,
      undefined,
      {
        "if-match": `"${rev}"`,
      },
    );
    rev = removed.json.rev;
    expect((await publish("admin", reportId, rev, "1.0.0")).json.code).toBe(
      "semver_not_increasing",
    );
    expect((await publish("member", reportId, rev, "1.1.0")).status).toBe(403);
    const bump = await as.admin.get(`${BASE}/${reportId}/draft/bump`);
    expect(bump.json).toMatchObject({
      latest: { semver: "1.0.0" },
      kind: "major",
      suggested: "2.0.0",
    });
  });

  it("publishes publisher site with the admin, audited; tells the publishing team's maintainers", async () => {
    const rev = (await as.admin.get(`${BASE}/${reportId}/draft`)).json.draft.rev as number;
    const res = await publish("admin", reportId, rev, "1.1.0");
    expect(res.status, json(res)).toBe(201);
    expect(res.json).toMatchObject({
      version: { semver: "1.1.0", previous: { publisher: "maintainer", semver: "1.0.0" } },
      notified: 1,
    });
    const row = (
      await h.admin.query(
        `SELECT publisher::text, state::text, submitted_by, reviewed_by, provenance, approved_at
           FROM registry_versions WHERE id = $1`,
        [res.json.version.versionId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      publisher: "site",
      state: "approved",
      submitted_by: ids.admin,
      reviewed_by: null,
    });
    expect(row.provenance).toMatchObject({
      publisher: "site",
      publishedBy: { userId: ids.admin },
      previous: { publisher: "maintainer", semver: "1.0.0" },
    });
    expect(await audits("registry.version_published", reportId)).toEqual([
      expect.objectContaining({
        actor_id: ids.admin,
        target: expect.objectContaining({
          publisher: "site",
          publishedBy: ids.admin,
          semver: "1.1.0",
          previousPublisher: "maintainer",
        }),
      }),
    ]);
    // The draft went with the publish.
    expect((await as.admin.get(`${BASE}/${reportId}/draft`)).status).toBe(404);
    const bell = await as.maintainer.get("/v1/notifications");
    expect(bell.status, json(bell)).toBe(200);
    expect(bell.json.notifications).toEqual([
      expect.objectContaining({
        kind: "skill.version.site_published",
        skill_name: "site-report",
        skill_semver: "1.1.0",
        actor_name: "admin",
      }),
    ]);
  });
});

describe("guards", () => {
  it("refuses retired skills until restored, and blocklisted ones", async () => {
    const id = await maintainerSkill("retired-report");
    const versionId = (await as.admin.get(`${BASE}/${id}`)).json.versions[0].id as string;
    await h.admin.query(`UPDATE registry_skills SET status = 'deprecated' WHERE id = $1`, [id]);
    expect((await as.admin.post(`${BASE}/${id}/draft`, { versionId })).json.code).toBe(
      "skill_retired",
    );
    await h.admin.query(`UPDATE registry_skills SET status = 'active' WHERE id = $1`, [id]);
    const hash = (await as.admin.get(`${BASE}/${id}`)).json.versions[0].runtimeHash as string;
    await h.admin.query(
      `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'Bad.', $2)`,
      [hash, ids.admin],
    );
    expect((await as.admin.post(`${BASE}/${id}/draft`, { versionId })).json.code).toBe(
      "skill_blocklisted",
    );
  });
});

describe("Kobe-shipped skills (ac-4)", () => {
  let pdf: KobePackage;
  let pdfId = "";
  beforeAll(async () => {
    pdf = await readKobePackage(KOBE_PACKAGES_DIR, "pdf");
    const seeded = await seedKobeSkills({
      db: h.deps.database.db,
      blobs,
      log: quiet,
      packages: [pdf],
    });
    expect(seeded[0]?.action).toBe("created");
    pdfId = (
      await h.admin.query<{ id: string }>(`SELECT id FROM registry_skills WHERE name = 'pdf'`)
    ).rows[0]?.id as string;
  });

  it("detaches on the first edit; the seed skips it and records the shipped version", async () => {
    const view = await as.admin.get(`${BASE}/${pdfId}`);
    expect(view.json.kobe).toMatchObject({ detached: false });
    const started = await as.admin.post(`${BASE}/${pdfId}/draft`, {
      versionId: view.json.versions[0].id,
    });
    expect(started.status, json(started)).toBe(201);
    const after = await as.admin.get(`${BASE}/${pdfId}`);
    expect(after.json.kobe).toMatchObject({ detached: true, detachedFromVersion: pdf.semver });
    expect(await audits("skill.detached", pdfId)).toHaveLength(1);
    const newer = shippedAs(pdf, "1.1.0");
    const seeded = await seedKobeSkills({
      db: h.deps.database.db,
      blobs,
      log: quiet,
      packages: [newer],
    });
    expect(seeded[0]?.action).toBe("skipped_detached");
    const versions = await h.admin.query(
      `SELECT semver FROM registry_versions WHERE skill_id = $1`,
      [pdfId],
    );
    expect(versions.rows.map((r) => r.semver)).toEqual([pdf.semver]);
    expect((await as.admin.get(`${BASE}/${pdfId}`)).json.kobe).toMatchObject({
      shippedVersion: "1.1.0",
      updateAvailable: true,
    });
  });

  it("publishes a site version (Default sync in the Default's major), compares, resets only above it", async () => {
    const draft = (await as.admin.get(`${BASE}/${pdfId}`)).json.draft;
    const res = await publish("admin", pdfId, draft.rev, "1.0.5");
    expect(res.status, json(res)).toBe(201);
    expect(res.json).toMatchObject({ version: { previous: { publisher: "kobe" } }, notified: 0 });
    const sync = await h.admin.query(
      `SELECT kind::text FROM skill_default_syncs WHERE version_id = $1`,
      [res.json.version.versionId],
    );
    expect(sync.rows).toEqual([{ kind: "add" }]);
    const compare = await as.admin.get(`${BASE}/${pdfId}/kobe/compare`);
    expect(compare.status, json(compare)).toBe(200);
    expect(compare.json).toMatchObject({ current: { semver: "1.0.5", publisher: "site" } });
    // The release ships 1.0.0, not above the Site's 1.0.5: refused, still detached.
    const refused = await as.admin.post(`${BASE}/${pdfId}/kobe/reset`, {});
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "shipped_not_above", siteSemver: "1.0.5" });
    expect((await as.member.post(`${BASE}/${pdfId}/kobe/reset`, {})).status).toBe(403);
    // A release shipping 2.0.0 resets it, and the seed publishes 2.0.0 at once.
    const higher = shippedAs(pdf, "2.0.0");
    const db = h.deps.database.db;
    const reset = await runWithAuditContext(
      { actor: { kind: "user", id: ids.admin }, ip: null, userAgent: null },
      () =>
        resetToKobe(
          { db, blobs, log: quiet, packages: () => Promise.resolve([higher]) },
          pdfId,
          ids.admin,
        ),
    );
    expect(reset).toMatchObject({
      ok: true,
      shippedSemver: "2.0.0",
      seed: { action: "published" },
    });
    const after = (await as.admin.get(`${BASE}/${pdfId}`)).json;
    expect(after.kobe).toMatchObject({ detached: false, shippedVersion: null });
    expect(after.versions[0]).toMatchObject({ semver: "2.0.0", publisher: "kobe" });
    expect(await audits("skill.reset_to_kobe", pdfId)).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ shippedSemver: "2.0.0", fromSemver: pdf.semver }),
      }),
    ]);
  });
});

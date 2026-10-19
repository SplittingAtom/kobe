import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submissionRight } from "./skills/registry/maintainers.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-332 (SK24): names and maintainers. Kobe's names are reserved and a catalog name is taken
 * except by its maintainers (who are named in the refusal); near names are a reviewer hint. Its
 * maintainers (and Site admins) add and remove maintainers, never the last; Site admins reassign;
 * every change is audited. When the last active maintainer is deactivated the skill is
 * Unmaintained and Site admins are emailed; reactivation makes it active again.
 */
let h: Harness;
const ids = { admin: "", alice: "", bob: "", carol: "", pending: "" };
const as = {} as Record<"admin" | "alice" | "bob", TestBrowser>;
const skill = { checker: "", fresh: "", kobe: "" };

const skillRow = async (name: string, publisher = "maintainer") =>
  (
    await h.admin.query<{ id: string }>(
      `INSERT INTO registry_skills (name, publisher, summary) VALUES ($1, $2, 'S.') RETURNING id`,
      [name, publisher],
    )
  ).rows[0]?.id as string;

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@maint.test", "admin");
  for (const who of ["alice", "bob", "carol", "pending"] as const)
    ids[who] = await h.createUser(`${who}@maint.test`);
  await h.admin.query(`UPDATE users SET name = initcap(split_part(email, '@', 1))`);
  skill.checker = await skillRow("invoice-checker");
  skill.fresh = await skillRow("fresh-skill");
  skill.kobe = await skillRow("pdf", "kobe");
  await h.admin.query(`INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2)`, [
    skill.checker,
    ids.alice,
  ]);
  // fresh-skill has no maintainer yet: `pending` submitted its first version, not yet approved.
  await h.admin.query(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
       provenance, source, scan, verdict, state, submitted_by)
     VALUES ($1, '0.1.0', 1, repeat('a', 64), repeat('a', 64), '{}', '{}', '{}', '{}', 'pass',
       'submitted', $2)`,
    [skill.fresh, ids.pending],
  );
  as.admin = await h.signIn("admin@maint.test");
  as.alice = await h.signIn("alice@maint.test");
  as.bob = await h.signIn("bob@maint.test");
});

afterAll(async () => {
  await h?.close();
});

const audit = async (action: string) =>
  (
    await h.admin.query<{ actor_id: string; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;
const M = (id: string) => `/v1/skills/catalog/${id}/maintainers`;
const db = () => h.deps.database.db;

describe("names (ac-1)", () => {
  it("refuses Kobe's names and a taken name, naming its maintainers; a new name is free", async () => {
    expect(await submissionRight(db(), "pdf", ids.bob)).toMatchObject({
      ok: false,
      code: "reserved",
    });
    expect(await submissionRight(db(), "brand-new", ids.bob)).toEqual({ ok: true, skill: null });
    expect(await submissionRight(db(), "invoice-checker", ids.bob)).toEqual({
      ok: false,
      code: "not_maintainer",
      message:
        "invoice-checker is maintained by Alice; fork it under a new name or ask to be added.",
    });
    expect(await submissionRight(db(), "invoice-checker", ids.alice)).toMatchObject({ ok: true });
    // Before its first approval only its submitter may send another version.
    expect(await submissionRight(db(), "fresh-skill", ids.pending)).toMatchObject({ ok: true });
    expect(await submissionRight(db(), "fresh-skill", ids.bob)).toMatchObject({
      ok: false,
      code: "taken",
    });
    // The database keeps the namespace flat and Kobe's names Kobe's.
    await expect(
      h.admin.query(`INSERT INTO registry_skills (name, summary) VALUES ('invoice-checker', 'x')`),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      h.admin.query(`INSERT INTO registry_skills (name, summary) VALUES ('xlsx', 'x')`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("hints at near names to reviewers, never to members", async () => {
    const r = await as.admin.get("/v1/site/skills/registry/similar?name=invoice-checkr");
    expect(r.json).toEqual({ similar: ["invoice-checker"] });
    expect((await as.bob.get("/v1/site/skills/registry/similar?name=x")).status).toBe(403);
  });
});

describe("maintainers (ac-2)", () => {
  it("are changed by maintainers and Site admins only, never the last, and audited", async () => {
    expect((await as.bob.get(M(skill.checker))).json.maintainers).toMatchObject([
      { userId: ids.alice, name: "Alice", deactivated: false },
    ]);
    expect((await as.bob.post(M(skill.checker), { userId: ids.bob })).status).toBe(403);
    const added = await as.alice.post(M(skill.checker), { userId: ids.bob });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect((await as.bob.delete(`${M(skill.checker)}/${ids.alice}`)).status).toBe(200);
    const last = await as.bob.delete(`${M(skill.checker)}/${ids.bob}`);
    expect([last.status, last.json.code]).toEqual([409, "last_maintainer"]);
    expect((await as.bob.put(M(skill.checker), { userIds: [ids.carol] })).status).toBe(403);
    const reassigned = await as.admin.put(M(skill.checker), { userIds: [ids.carol] });
    expect(reassigned.json.maintainers.map((m: { userId: string }) => m.userId)).toEqual([
      ids.carol,
    ]);
    expect((await as.admin.post(M(skill.kobe), { userId: ids.bob })).status).toBe(403);
    expect(
      (await audit("skill.maintainer.added")).map((a) => [a.actor_id, a.target.userId]),
    ).toEqual([[ids.alice, ids.bob]]);
    expect(
      (await audit("skill.maintainer.removed")).map((a) => [a.actor_id, a.target.userId]),
    ).toEqual([[ids.bob, ids.alice]]);
    expect((await audit("skill.maintainers.reassigned")).map((a) => a.target)).toEqual([
      { skillId: skill.checker, userIds: [ids.carol] },
    ]);
  });
});

describe("Unmaintained (ac-3)", () => {
  it("marks the skill when its last maintainer is deactivated, emails Site admins, and recovers", async () => {
    const before = h.mailer.sent.length;
    expect((await as.admin.post(`/v1/site/users/${ids.carol}/deactivate`, {})).status).toBe(200);
    const status = async () =>
      (await h.admin.query(`SELECT status FROM registry_skills WHERE id = $1`, [skill.checker]))
        .rows[0]?.status;
    expect(await status()).toBe("unmaintained");
    expect(await audit("skill.catalog.unmaintained")).toMatchObject([
      { target: { skillId: skill.checker, name: "invoice-checker" } },
    ]);
    const mail = h.mailer.sent.slice(before).filter((m) => /unmaintained/i.test(m.subject));
    expect(mail.map((m) => m.to)).toEqual(["admin@maint.test"]);
    expect(mail[0]?.text).toContain("invoice-checker");
    expect((await as.admin.post(`/v1/site/users/${ids.carol}/reactivate`, {})).status).toBe(200);
    expect(await status()).toBe("active");
    expect((await audit("skill.catalog.maintained")).length).toBe(1);
  });
});

describe("Unmaintained stays closed to former maintainers (KOBE-332 review C3-M1)", () => {
  it("refuses a removed maintainer until a Site admin reassigns the skill", async () => {
    const lapsed = await skillRow("lapsed-skill");
    await h.admin.query(
      `INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [lapsed, ids.alice, ids.bob],
    );
    // Alice submitted its first version, then Bob removed her; then Bob is deactivated.
    await h.admin.query(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
         provenance, source, scan, verdict, state, submitted_by)
       VALUES ($1, '0.1.0', 1, repeat('c', 64), repeat('c', 64), '{}', '{}', '{}', '{}', 'pass',
         'submitted', $2)`,
      [lapsed, ids.alice],
    );
    expect((await as.bob.delete(`${M(lapsed)}/${ids.alice}`)).status).toBe(200);
    expect((await as.admin.post(`/v1/site/users/${ids.bob}/deactivate`, {})).status).toBe(200);
    const status = await h.admin.query(`SELECT status FROM registry_skills WHERE id = $1`, [
      lapsed,
    ]);
    expect(status.rows[0]?.status).toBe("unmaintained");
    expect(await submissionRight(db(), "lapsed-skill", ids.alice)).toEqual({
      ok: false,
      code: "unmaintained",
      message: "lapsed-skill is Unmaintained: ask a Site admin to reassign its maintainers.",
    });
    expect(await submissionRight(db(), "lapsed-skill", ids.carol)).toMatchObject({
      ok: false,
      code: "unmaintained",
    });
    // A Site admin reassigning it reopens submissions to the new maintainer only.
    expect((await as.admin.put(M(lapsed), { userIds: [ids.alice] })).status).toBe(200);
    expect(await submissionRight(db(), "lapsed-skill", ids.alice)).toMatchObject({ ok: true });
    expect(await submissionRight(db(), "lapsed-skill", ids.carol)).toMatchObject({
      ok: false,
      code: "not_maintainer",
    });
    await as.admin.post(`/v1/site/users/${ids.bob}/reactivate`, {});
  });
});

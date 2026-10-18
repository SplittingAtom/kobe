import { randomUUID } from "node:crypto";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageHash, runtimeHash } from "@kobe/protocol/node";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * Uploads over HTTP under the package contract (KOBE-309, KOBE-310): authored packages that
 * today's rules refuse are refused before anything is stored; a package with `evals/` and
 * `kobe.skill.yaml` is stored as its runtime zip (`content_hash` = runtime hash) plus its
 * package zip, the manifest numbers the version, and a download returns the whole package.
 */
const team = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
let admin: TestBrowser;

const SKILL_MD = "---\nname: packaged\ndescription: A packaged skill\n---\nUse it.\n";
const zipOf = (files: Record<string, string>) =>
  new RawBody(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])) as Zippable),
    "application/zip",
  );
const asMap = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([k, v]) => [k, strToU8(v)]));
const upload = (body: RawBody, query = "") => admin.post(`/v1/skills?scope=team${query}`, body);
const manifest = (version: string, name = "packaged") =>
  `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: ${version}\nsummary: Packaged.\nchangelog: From the manifest.\n`;

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  const id = await h.createUser("pkg@skills.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'pkg', 'Pkg')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [team, id],
  );
  admin = await h.signIn("pkg@skills.test");
  expect((await admin.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
  admin.team = team;
});

afterAll(async () => {
  await h?.close();
});

describe("refused before anything is stored", () => {
  for (const [what, files, code] of [
    ["a root provenance.json", { "provenance.json": "{}" }, "reserved_path"],
    ["a case variant of evals/", { "Evals/cases.yaml": "x" }, "reserved_path"],
    ["a file and folder clash", { scripts: "x", "scripts/run.py": "y" }, "path_conflict"],
    ["a bidi control in a name", { "run‮gnp.sh": "x" }, "unsafe_path"],
    ["an invalid kobe.skill.yaml", { "kobe.skill.yaml": "apiVersion: nope\n" }, "invalid_manifest"],
  ] as const) {
    it(what, async () => {
      const before = objects.objects.size;
      const res = await upload(zipOf({ "SKILL.md": SKILL_MD, ...files }));
      expect(res.status, JSON.stringify(res.json)).toBe(400);
      expect(res.json.code).toBe(code);
      expect(objects.objects.size).toBe(before);
    });
  }
});

describe("packages with evals/ and kobe.skill.yaml", () => {
  const files = {
    "SKILL.md": SKILL_MD,
    "scripts/run.py": "print(1)\n",
    "evals/cases.yaml": "cases: []\n",
    "kobe.skill.yaml": manifest("1.2.0"),
  };

  it("stores the runtime zip as the content hash and numbers the version from the manifest", async () => {
    const res = await upload(zipOf(files));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.version).toMatchObject({
      semver: "1.2.0",
      changelog: "From the manifest.",
      contentHash: runtimeHash(asMap(files)),
      packageHash: packageHash(asMap(files)),
      fileCount: 2,
    });
    const id = res.json.skill.id as string;
    const bundle = await admin.get(`/v1/skills/${id}/versions/1.2.0/bundle`);
    expect(bundle.status).toBe(200);
    expect(Object.keys(unzipSync(bundle.bytes)).sort()).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "kobe.skill.yaml",
      "scripts/run.py",
    ]);
  });

  it("refuses a requested semver that differs from the manifest's version", async () => {
    const res = await upload(
      zipOf({ ...files, "kobe.skill.yaml": manifest("1.3.0"), "scripts/run.py": "print(2)\n" }),
      "&semver=1.4.0",
    );
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/kobe\.skill\.yaml/);
  });

  it("makes an evals-only change a new version with the same runtime hash", async () => {
    const res = await upload(
      zipOf({ ...files, "evals/cases.yaml": "cases: [1]\n", "kobe.skill.yaml": manifest("1.2.1") }),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.version).toMatchObject({
      seq: 2,
      semver: "1.2.1",
      contentHash: runtimeHash(asMap(files)),
    });
  });

  it("refuses a manifest that names another skill", async () => {
    const res = await upload(zipOf({ ...files, "kobe.skill.yaml": manifest("9.0.0", "other") }));
    expect(res).toMatchObject({ status: 400, json: { code: "invalid_manifest" } });
  });
});

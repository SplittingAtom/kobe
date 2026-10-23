// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "../testing";
import { CatalogSkillEditor } from "./catalog-skill-editor";
import { CatalogSkillPage } from "./catalog-skill-page";

/**
 * Site catalog skills (KOBE-495): the view (versions, a version's files read-only, frontmatter,
 * provenance, hashes), Edit from a version (asks first for a Kobe skill: it detaches), the
 * detached notice with Compare and Reset to Kobe, and the site draft in the Workbench editor with
 * Save version (semver confirmed; a scan Block shows its findings).
 */
const BASE = "/v1/site/skills/catalog-skills";
const text = (s: string) => new TextEncoder().encode(s);
const VERSION = {
  id: "v-1",
  semver: "1.0.0",
  seq: 1,
  publisher: "kobe",
  state: "approved",
  verdict: "pass",
  approvedAt: "2026-10-20T10:00:00Z",
  submittedAt: "2026-10-20T10:00:00Z",
  submittedBy: null,
  runtimeHash: "a".repeat(64),
  packageHash: "b".repeat(64),
  changelog: "First.",
  stored: true,
};
const ATTACHED = {
  detached: false,
  detachedAt: null,
  detachedBy: null,
  detachedFromVersion: null,
  shippedVersion: null,
  updateAvailable: false,
};
const SKILL = {
  id: "s-1",
  name: "pdf",
  summary: "Reads PDFs.",
  publisher: "kobe",
  status: "active",
  retired: false,
  blocklisted: false,
  kobe: ATTACHED,
  draft: null,
  versions: [VERSION],
};
const VIEW = {
  version: VERSION,
  files: [
    { path: "SKILL.md", size: 40, kind: "text" },
    { path: "scripts/run.py", size: 12, kind: "text" },
  ],
  frontmatter: { name: "pdf", description: "Reads PDFs." },
  frontmatterProblem: null,
  manifest: { version: "1.0.0" },
  provenance: { publisher: "kobe" },
  scan: { verdict: "pass", findings: [], scripts: ["scripts/run.py"], skipped: [] },
  hashes: { runtime: "a".repeat(64), package: "b".repeat(64) },
};
const SKILL_MD = "---\nname: pdf\ndescription: Reads PDFs.\n---\n# pdf\n\nRead it.\n";
const RAW = {
  path: "SKILL.md",
  size: SKILL_MD.length,
  sha256: "c".repeat(64),
  encoding: "text",
  text: SKILL_MD,
  truncated: false,
};
const DRAFT = {
  id: "d-1",
  skillId: "s-1",
  baseVersionId: "v-1",
  rev: 3,
  sizeBytes: 60,
  fileCount: 1,
  updatedAt: "2026-10-23T10:00:00Z",
  updatedBy: "Ada",
};
const DRAFT_INFO = {
  baseVersionId: "v-1",
  baseSemver: "1.0.0",
  rev: 3,
  updatedAt: DRAFT.updatedAt,
  updatedBy: "Ada",
};
const FILES = [{ path: "SKILL.md", size: 60, kind: "text", updatedAt: DRAFT.updatedAt }];
const SCAN = { rev: 3, verdict: "pass", findings: [], scripts: [], skipped: [] };

beforeEach(() => forbidNativeConfirm());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("catalog skill view (ac-1)", () => {
  it("lists versions and shows a version's files, frontmatter, provenance and hashes", async () => {
    stubApi({
      [`GET ${BASE}/s-1`]: [200, SKILL],
      [`GET ${BASE}/s-1/versions/v-1`]: [200, VIEW],
      [`GET ${BASE}/s-1/versions/v-1/files/SKILL.md`]: [200, RAW],
    });
    renderSite(<CatalogSkillPage skillId="s-1" />);
    expect(await screen.findByRole("heading", { name: /pdf/ })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: /1\.0\.0/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "scripts/run.py" })).toBeTruthy();
    expect(screen.getAllByText("a".repeat(64)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("SKILL.md frontmatter").textContent).toContain('"name": "pdf"');
    expect(screen.getByLabelText("provenance.json, as recorded").textContent).toContain(
      '"publisher": "kobe"',
    );
    // SKILL.md opens rendered; Raw switches to the read-only viewer.
    expect(await screen.findByText("Read it.")).toBeTruthy();
  });

  it("asks before editing a Kobe skill (it detaches), then starts the site draft", async () => {
    const calls = stubApi({
      [`GET ${BASE}/s-1`]: [200, SKILL],
      [`GET ${BASE}/s-1/versions/v-1`]: [200, VIEW],
      [`GET ${BASE}/s-1/versions/v-1/files/SKILL.md`]: [200, RAW],
      [`POST ${BASE}/s-1/draft`]: [201, { draft: DRAFT, files: FILES }],
    });
    renderSite(<CatalogSkillPage skillId="s-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit pdf from 1.0.0" }));
    expect(await answerConfirm(/Edit pdf, a Kobe skill/, "Edit and detach")).toMatch(/detaches/);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ versionId: "v-1" });
  });

  it("says a newer Kobe version is available, compares, and resets after asking", async () => {
    const detached = {
      ...SKILL,
      kobe: {
        ...ATTACHED,
        detached: true,
        detachedFromVersion: "1.0.0",
        shippedVersion: "1.1.0",
        updateAvailable: true,
      },
    };
    const calls = stubApi({
      [`GET ${BASE}/s-1`]: [200, detached],
      [`GET ${BASE}/s-1/versions/v-1`]: [200, VIEW],
      [`GET ${BASE}/s-1/versions/v-1/files/SKILL.md`]: [200, RAW],
      [`GET ${BASE}/s-1/kobe/compare`]: [
        200,
        {
          current: { id: "v-1", semver: "1.0.0", publisher: "kobe" },
          shipped: { semver: "1.1.0" },
          diff: {
            files: [
              {
                path: "SKILL.md",
                status: "changed",
                size: 10,
                binary: false,
                hunks: [
                  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
                ],
              },
            ],
            changedFiles: 1,
            truncated: false,
          },
        },
      ],
      [`POST ${BASE}/s-1/kobe/reset`]: [
        409,
        {
          code: "shipped_not_above",
          message: "Kobe ships 1.1.0, which is not above the Site's 1.2.0.",
        },
      ],
    });
    renderSite(<CatalogSkillPage skillId="s-1" />);
    expect(
      await screen.findByText(/A newer Kobe version of pdf is available \(1\.1\.0/),
    ).toBeTruthy();
    expect(screen.getByText("Detached")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Compare/ }));
    expect(await screen.findByText(/Kobe ships 1\.1\.0/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Reset to Kobe/ }));
    await answerConfirm(/Reset pdf to Kobe/, "Reset to Kobe");
    expect(await screen.findByText(/not above the Site's 1\.2\.0/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses editing a retired skill", async () => {
    stubApi({
      [`GET ${BASE}/s-1`]: [200, { ...SKILL, retired: true, status: "deprecated" }],
      [`GET ${BASE}/s-1/versions/v-1`]: [200, VIEW],
      [`GET ${BASE}/s-1/versions/v-1/files/SKILL.md`]: [200, RAW],
    });
    renderSite(<CatalogSkillPage skillId="s-1" />);
    expect(await screen.findByText(/pdf is deprecated\. Restore it first/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Edit pdf from 1.0.0" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("site draft editor (ac-2, ac-3)", () => {
  const routes = (publish: readonly [number, unknown]): Parameters<typeof stubApi>[0] => ({
    [`GET ${BASE}/s-1`]: [200, { ...SKILL, draft: DRAFT_INFO }],
    [`GET ${BASE}/s-1/draft`]: [200, { draft: DRAFT, files: FILES }],
    [`GET ${BASE}/s-1/draft/files/SKILL.md`]: [200, text(SKILL_MD)],
    [`GET ${BASE}/s-1/draft/scan`]: [200, SCAN],
    [`GET ${BASE}/s-1/draft/bump`]: [
      200,
      {
        rev: 3,
        latest: { skillId: "s-1", semver: "1.0.0" },
        kind: "minor",
        suggested: "1.1.0",
        reasons: ["SKILL.md instructions changed"],
      },
    ],
    [`POST ${BASE}/s-1/draft/publish`]: publish,
  });

  it("loads the persisted draft and publishes the confirmed version", async () => {
    const calls = stubApi(
      routes([
        201,
        {
          version: {
            versionId: "v-2",
            skillId: "s-1",
            name: "pdf",
            semver: "1.1.0",
            verdict: "pass",
            previous: { publisher: "kobe", semver: "1.0.0" },
          },
          notified: 0,
        },
      ]),
    );
    renderSite(<CatalogSkillEditor skillId="s-1" />);
    expect(await screen.findByRole("heading", { name: "Edit pdf" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    const version = await screen.findByRole("textbox", { name: /Version/ });
    await waitFor(() => expect((version as HTMLInputElement).value).toBe("1.1.0"));
    await userEvent.type(screen.getByRole("textbox", { name: /Changelog/ }), "Clearer steps.");
    await userEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(await screen.findByText(/Published pdf 1\.1\.0 to the Catalog/)).toBeTruthy();
    const publish = calls.find((c) => c.method === "POST");
    expect(publish?.headers.get("if-match")).toBe('"3"');
    expect(JSON.parse(String(publish?.body))).toEqual({
      semver: "1.1.0",
      changelog: "Clearer steps.",
    });
  });

  it("shows the findings when the scan blocks the version", async () => {
    const blocked = {
      ...SCAN,
      verdict: "block",
      findings: [
        {
          category: "binary",
          rule: "compiled-code",
          file: "lib/mod.pyc",
          line: 0,
          excerpt: "",
          severity: "block",
        },
      ],
    };
    const r = routes([422, { code: "scan_block", message: "The scan blocks this version." }]);
    stubApi({
      ...r,
      [`GET ${BASE}/s-1/draft/scan`]: [
        [200, SCAN],
        [200, blocked],
      ],
    });
    renderSite(<CatalogSkillEditor skillId="s-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Save version" }));
    await userEvent.type(await screen.findByRole("textbox", { name: /Changelog/ }), "X.");
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: /Version/ }) as HTMLInputElement).value).toBe(
        "1.1.0",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(await screen.findByText(/The scan blocks this version/)).toBeTruthy();
    expect((await screen.findAllByText(/lib\/mod\.pyc/)).length).toBeGreaterThan(0);
  });
});

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberDraftTab, rememberedDraftTab } from "../../lib/skills/draft-tabs";
import { must } from "../../lib/testing/must";
import { forbidNativeConfirm, renderTeam, stubApi, type RecordedCall } from "../admin/testing";
import { DraftEditorPage } from "./draft-editor-page";

/**
 * KOBE-459: the draft page's Define, Test and Eval tabs. The header, Save version, the status
 * line and the draft settings stay above them (ac-1); Define holds the tree and the editor rail
 * (ac-2); the tab is in the address and remembered per draft (ac-6); Test and Eval get the edits
 * written first (ac-4); Eval lists the draft's runs with its saved skill's (ac-5).
 */
const BUILDER = {
  role: "builder",
  permissions: ["team.personal.create", "team.skills.publish"],
} as const;
const SKILL_MD =
  "---\nname: report-writer\ndescription: Writes reports. Use when asked.\n---\nBody.\n";
const DRAFT = (rev: number) => ({
  id: "d-1",
  name: "report-writer",
  shared: false,
  mine: true,
  owner_user_id: "u-me",
  started_from: "blank",
  parent_ref: null,
  from_conversation: false,
  co_edited: false,
  rev,
  size_bytes: 100,
  file_count: 2,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  updated_by: "u-me",
});
const FILES = [
  { path: "SKILL.md", size: 80, kind: "text", updated_at: "x" },
  { path: "references/guide.md", size: 6, kind: "text", updated_at: "x" },
];
const SCAN = { rev: 3, verdict: "pass", findings: [], scripts: [], skipped: [] };
const evalRun = (id: string, startedAt: string, subject: Record<string, unknown>) => ({
  id,
  subject,
  package_hash: "a".repeat(64),
  mode: "with_only",
  status: "failed",
  progress: { done: 0, total: 1 },
  scorecard: null,
  failure: null,
  started_by: "u-me",
  started_at: startedAt,
  finished_at: startedAt,
});
const ROUTES = {
  "GET /v1/skills/drafts/d-1": [200, { draft: DRAFT(3), files: FILES }],
  "GET /v1/skills/drafts/d-1/files/SKILL.md": [200, new TextEncoder().encode(SKILL_MD)],
  "GET /v1/skills/drafts/d-1/files/references/guide.md": [200, new TextEncoder().encode("Guide.")],
  "GET /v1/skills/drafts/d-1/scan": [200, SCAN],
  "PUT /v1/skills/drafts/d-1/files/SKILL.md": [200, { rev: 4, draft: DRAFT(4) }],
  "GET /v1/skill-evals?draft_id=d-1": [
    200,
    {
      evals: [
        evalRun("e-draft", "2026-10-17T10:00:00Z", { kind: "draft", draft_id: "d-1", rev: 2 }),
      ],
    },
  ],
  "GET /v1/skills": [
    200,
    {
      skills: [
        {
          id: "s-1",
          scope: "team",
          slug: "report-writer",
          description: "",
          latest_version: 2,
          latest_semver: "1.1.0",
          owner_user_id: null,
          created_at: "x",
          updated_at: "x",
        },
        {
          id: "s-9",
          scope: "team",
          slug: "something-else",
          description: "",
          latest_version: 1,
          latest_semver: "0.1.0",
          owner_user_id: null,
          created_at: "x",
          updated_at: "x",
        },
      ],
    },
  ],
  "GET /v1/skill-evals?scope=team&skill_id=s-1": [
    200,
    {
      evals: [
        evalRun("e-saved", "2026-10-18T10:00:00Z", {
          kind: "version",
          scope: "team",
          skill_id: "s-1",
          seq: 2,
        }),
      ],
    },
  ],
} as const;

async function opened(tab: Parameters<typeof DraftEditorPage>[0]["tab"] = null) {
  const calls = stubApi(ROUTES as unknown as Parameters<typeof stubApi>[0]);
  renderTeam(<DraftEditorPage draftId="d-1" tab={tab} />, BUILDER);
  await screen.findByRole("tablist", { name: "Draft" });
  return calls;
}

const tabNamed = (name: string) => screen.getByRole("tab", { name });
const puts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  forbidNativeConfirm();
  localStorage.clear();
  window.history.replaceState(null, "", "/me/skills/drafts/d-1");
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

describe("the draft page's tabs (ac-1, ac-2)", () => {
  it("shows Define, Test and Eval below the header, Save version, the status line and settings", async () => {
    await opened();
    const list = screen.getByRole("tablist", { name: "Draft" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Define", "Test", "Eval"]);
    expect(tabNamed("Define").getAttribute("aria-selected")).toBe("true");
    // Above the tabs on every tab.
    const above = (el: Element) =>
      Boolean(el.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
    for (const el of [
      screen.getByRole("button", { name: "Save version" }),
      screen.getByText("All changes saved."),
      screen.getByRole("switch", { name: /Share with team builders/ }),
    ])
      expect(above(el)).toBe(true);
    // Define: the tree, then the editor rail with the form, Lint and Scan.
    const define = screen.getByRole("tabpanel", { name: "Define" });
    expect(within(define).getByRole("navigation", { name: "Files" })).toBeDefined();
    expect(within(define).getByLabelText("Name")).toBeDefined();
    expect(within(define).getByLabelText("Description")).toBeDefined();
    expect(within(define).getByText("Scanned as saved (revision 3).")).toBeDefined();
    expect(within(define).getByRole("separator", { name: "Resize the editor" })).toBeDefined();
    // Another file in the tree shows in the rail.
    await userEvent.click(within(define).getByRole("button", { name: "references/guide.md" }));
    expect(await within(define).findByLabelText("Contents of references/guide.md")).toBeDefined();
  });

  it("moves between the tabs with the arrow keys; Test and Eval stay above the same header", async () => {
    await opened();
    tabNamed("Define").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(tabNamed("Test").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Test" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Save version" })).toBeDefined();
    await userEvent.keyboard("{ArrowRight}");
    expect(tabNamed("Eval").getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowRight}");
    expect(tabNamed("Define").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the tab in the address, remembered per draft (ac-6)", () => {
  it("puts the chosen tab in the address and remembers it for this draft", async () => {
    await opened();
    await userEvent.click(tabNamed("Eval"));
    expect(new URL(window.location.href).searchParams.get("tab")).toBe("eval");
    expect(rememberedDraftTab("d-1")).toBe("eval");
  });

  it("opens on the address's tab, else the remembered one, else Define", async () => {
    rememberDraftTab("d-1", "test");
    await opened("eval");
    expect(tabNamed("Eval").getAttribute("aria-selected")).toBe("true");
    // Opening a tab by its address counts as using it.
    expect(rememberedDraftTab("d-1")).toBe("eval");
    cleanup();
    rememberDraftTab("d-1", "test");
    await opened(null);
    expect(tabNamed("Test").getAttribute("aria-selected")).toBe("true");
    expect(new URL(window.location.href).searchParams.get("tab")).toBe("test");
    cleanup();
    localStorage.clear();
    await opened(null);
    expect(tabNamed("Define").getAttribute("aria-selected")).toBe("true");
  });

  it("an unknown ?tab= (read as Define by the page) opens Define", async () => {
    rememberDraftTab("d-1", "eval");
    await opened("define");
    expect(tabNamed("Define").getAttribute("aria-selected")).toBe("true");
  });
});

describe("Test and Eval write the edits first (ac-4)", () => {
  it("writes a pending edit when the member leaves Define", async () => {
    const calls = await opened();
    await screen.findByText("Scanned as saved (revision 3).");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Writes monthly reports. Use when asked for one." },
    });
    expect(puts(calls)).toHaveLength(0);
    fireEvent.mouseDown(tabNamed("Test"));
    fireEvent.click(tabNamed("Test"));
    await act(() => vi.advanceTimersByTimeAsync(50));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(String(must(puts(calls)[0]).body)).toContain("Writes monthly reports.");
  });
});

describe("Eval: the merged history (ac-5)", () => {
  it("lists the draft's runs and its saved skill's, labelled by source, newest first", async () => {
    await opened("eval");
    const panel = screen.getByRole("tabpanel", { name: "Eval" });
    const history = await within(panel).findByRole("table", { name: "Eval history" });
    await waitFor(() => expect(within(history).getAllByRole("row")).toHaveLength(3));
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Team skill report-writer",
      "This draft",
    ]);
    expect(within(must(rows[0])).getByText("v1.1.0")).toBeDefined();
    expect(within(must(rows[0])).getByRole("link").getAttribute("href")).toContain("e-saved");
  });
});

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import {
  answerConfirm,
  forbidNativeConfirm,
  renderTeam,
  stubApi,
  type RecordedCall,
} from "../admin/testing";
import { DraftEditorPage } from "./draft-editor-page";

/**
 * KOBE-321: the Workbench editor. Lint updates as you type and the scan preview of the saved
 * draft within 2 s (ac-2); the description meter warns at both thresholds; Save version suggests
 * the bump the server works out and saves the revision the author saw (ac-3).
 */
const BUILDER = {
  role: "builder",
  permissions: ["team.personal.create", "team.skills.publish"],
} as const;
const SKILL_MD = [
  "---",
  "name: report-writer",
  "description: Writes monthly reports. Use when asked for a report.",
  "---",
  "Run `scripts/build.py`. See [the guide](references/guide.md).",
  "",
].join("\n");
const DRAFT = (rev: number, extra: Record<string, unknown> = {}) => ({
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
  file_count: 4,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  updated_by: "u-me",
  ...extra,
});
const FILES = [
  { path: "SKILL.md", size: 120, kind: "text", updated_at: "x" },
  { path: "references/guide.md", size: 6, kind: "text", updated_at: "x" },
  { path: "scripts/build.py", size: 9, kind: "text", updated_at: "x" },
  { path: "assets/logo.png", size: 4, kind: "binary", updated_at: "x" },
];
const bytes = (s: string) => new TextEncoder().encode(s);
const SCAN = (rev: number, verdict = "pass", findings: unknown[] = []) => ({
  rev,
  verdict,
  findings,
  scripts: ["scripts/build.py"],
  skipped: ["assets/logo.png"],
  rule_set_version: "4",
});
const BASE = {
  "GET /v1/skills/drafts/d-1": [200, { draft: DRAFT(3), files: FILES }],
  "GET /v1/skills/drafts/d-1/files/SKILL.md": [200, bytes(SKILL_MD)],
  "GET /v1/skills/drafts/d-1/files/references/guide.md": [200, bytes("Guide.")],
  "GET /v1/skills/drafts/d-1/scan": [
    [200, SCAN(3)],
    [
      200,
      SCAN(4, "caution", [
        {
          category: "network",
          rule: "curl",
          file: "scripts/build.py",
          line: 2,
          excerpt: "curl https://x.test",
          severity: "caution",
        },
      ]),
    ],
  ],
  "PUT /v1/skills/drafts/d-1/files/SKILL.md": [200, { rev: 4, draft: DRAFT(4) }],
} as const;

const puts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PUT");
const scans = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith("/scan"));

async function opened(routes: Record<string, unknown> = BASE) {
  const calls = stubApi(routes as Parameters<typeof stubApi>[0]);
  renderTeam(<DraftEditorPage draftId="d-1" />, BUILDER);
  await screen.findByDisplayValue("report-writer");
  await screen.findByText("Scanned as saved (revision 3).");
  return calls;
}

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn() });
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  // Unmounting writes pending edits (review B2): let those reach the stub before it goes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

describe("Workbench editor: lint, meter and live scan (ac-2)", () => {
  it("lints on every keystroke and shows the scan of the saved edit within 2 s", async () => {
    const calls = await opened();
    // The draft has no evals/: one warning; Pass for revision 3.
    expect(screen.getByText("0 errors, 1 warning.")).toBeDefined();
    expect(screen.getByText("Pass", { selector: "[data-slot=console-badge]" })).toBeDefined();
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Report Writer" } });
    // Lint is immediate: no timer has run yet.
    expect(screen.getByText(/The name must be lowercase/)).toBeDefined();
    expect(screen.getByText("1 error, 1 warning.")).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    const put = must(puts(calls)[0]);
    expect(put.headers.get("if-match")).toBe('"3"');
    expect(put.body).toContain("name: Report Writer");
    expect(scans(calls)).toHaveLength(2);
    expect(screen.getByText("Caution", { selector: "[data-slot=console-badge]" })).toBeDefined();
    expect(screen.getByText("Scanned as saved (revision 4).")).toBeDefined();
    expect(screen.getByText(/curl https:\/\/x\.test/)).toBeDefined();
    expect(screen.getByText("All changes saved.")).toBeDefined();
  });

  it("saves at least every 1.2 s while typing goes on", async () => {
    const calls = await opened();
    vi.useFakeTimers();
    const body = screen.getByLabelText("Instructions (SKILL.md body)");
    for (let i = 0; i < 6; i++) {
      fireEvent.change(body, { target: { value: `Edit ${i}. Run \`scripts/build.py\`.` } });
      await act(() => vi.advanceTimersByTimeAsync(300));
    }
    expect(puts(calls).length).toBeGreaterThanOrEqual(1);
  });

  it("warns past 1,024 and again past 1,536 description characters", async () => {
    await opened();
    const description = screen.getByLabelText("Description");
    fireEvent.change(description, { target: { value: "Use when asked. " + "x".repeat(1008) } });
    expect(screen.getByText(/1,024 \/ 1,024 characters/)).toBeDefined();
    expect(screen.queryByText(/the Agent Skills limit/)).toBeNull();
    fireEvent.change(description, { target: { value: "Use when asked. " + "x".repeat(1009) } });
    expect(screen.getByText(/the Agent Skills limit: Save version refuses it/)).toBeDefined();
    fireEvent.change(description, { target: { value: "Use when asked. " + "x".repeat(1521) } });
    expect(screen.getByText(/Past 1,536 characters: Claude Code cuts it off too/)).toBeDefined();
    expect(description.getAttribute("aria-describedby")).toContain("skill-description-meter");
  });

  it("stops autosave on a stale revision and says who changed the draft", async () => {
    await opened({
      ...BASE,
      "PUT /v1/skills/drafts/d-1/files/SKILL.md": [
        409,
        {
          code: "stale_revision",
          message: "This draft was changed by Bo. Reload it to see their changes.",
        },
      ],
    });
    fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), {
      target: { value: "Mine." },
    });
    expect(await screen.findByText(/changed by Bo/)).toBeDefined();
    expect(screen.getByText("Not saved: someone else changed this draft.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Reload the draft" })).toBeDefined();
  });
});

describe("Workbench editor: review fixes (B2, S1, S2, S4)", () => {
  it("writes pending edits when the editor goes away (in-app navigation)", async () => {
    const calls = stubApi(BASE as unknown as Parameters<typeof stubApi>[0]);
    const view = renderTeam(<DraftEditorPage draftId="d-1" />, BUILDER);
    await screen.findByText("Scanned as saved (revision 3).");
    fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), {
      target: { value: "Left before the timer." },
    });
    expect(puts(calls)).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(must(puts(calls)[0]).body).toContain("Left before the timer.");
  });

  it("asks a busy scan again after 1 s, and shows an unfinished one as unavailable, not Block", async () => {
    const calls = await opened({
      ...BASE,
      "GET /v1/skills/drafts/d-1/scan": [
        [200, SCAN(3)],
        [429, { code: "scan_busy", message: "The scan preview is busy." }],
        [503, { code: "scan_unavailable", message: "The scan preview couldn't finish." }],
        [200, SCAN(4, "block", [])],
      ],
    });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), {
      target: { value: "Edit." },
    });
    await act(() => vi.advanceTimersByTimeAsync(1300));
    expect(screen.getByText(/Scan busy, trying again/)).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText(/Scan unavailable, retrying/)).toBeDefined();
    // The last complete scan still shows: Pass, never a Block for a scan that didn't finish.
    expect(screen.getByText("Pass", { selector: "[data-slot=console-badge]" })).toBeDefined();
    expect(scans(calls)).toHaveLength(3);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(scans(calls)).toHaveLength(4);
    expect(screen.getByText("Scanned as saved (revision 4).")).toBeDefined();
  });

  it("queues a new file behind a pending autosave, so it names the autosave's revision", async () => {
    const calls = await opened({
      ...BASE,
      "PUT /v1/skills/drafts/d-1/files/notes.md": [200, { rev: 5, draft: DRAFT(5) }],
    });
    fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), {
      target: { value: "Pending." },
    });
    await userEvent.type(screen.getByLabelText("New file"), "notes.md");
    await userEvent.click(screen.getByRole("button", { name: "Add file" }));
    await screen.findByLabelText("Contents of notes.md");
    expect(puts(calls).map((c) => [c.url.split("/files/")[1], c.headers.get("if-match")])).toEqual([
      ["SKILL.md", '"3"'],
      ["notes.md", '"4"'],
    ]);
  });
});

describe("Workbench editor: files", () => {
  it("opens a text file, adds one (lint follows) and deletes one after asking", async () => {
    const calls = await opened({
      ...BASE,
      "PUT /v1/skills/drafts/d-1/files/evals/cases.yaml": [200, { rev: 4, draft: DRAFT(4) }],
      "DELETE /v1/skills/drafts/d-1/files/references/guide.md": [200, { rev: 5, draft: DRAFT(5) }],
    });
    const tree = within(screen.getByRole("navigation", { name: "Files" }));
    expect(tree.getByRole("button", { name: "assets/logo.png (binary)" }).textContent).toContain(
      "(binary)",
    );
    await userEvent.click(tree.getByRole("button", { name: "references/guide.md" }));
    expect(
      ((await screen.findByLabelText("Contents of references/guide.md")) as HTMLTextAreaElement)
        .value,
    ).toBe("Guide.");
    await userEvent.type(screen.getByLabelText("New file"), "Evals/x.yaml");
    await userEvent.click(screen.getByRole("button", { name: "Add file" }));
    expect(screen.getByText(/spell them exactly so/)).toBeDefined();
    await userEvent.clear(screen.getByLabelText("New file"));
    await userEvent.type(screen.getByLabelText("New file"), "evals/cases.yaml");
    await userEvent.click(screen.getByRole("button", { name: "Add file" }));
    await screen.findByLabelText("Contents of evals/cases.yaml");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect([put.url, put.headers.get("if-match")]).toEqual([
      "/v1/skills/drafts/d-1/files/evals/cases.yaml",
      '"3"',
    ]);
    expect(screen.getByText("No problems found.")).toBeDefined();

    await userEvent.click(tree.getByRole("button", { name: "references/guide.md" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete references/guide.md" }),
    );
    await answerConfirm("Delete references/guide.md?", "Delete");
    await waitFor(() =>
      expect(tree.queryByRole("button", { name: "references/guide.md" })).toBeNull(),
    );
    const del = must(calls.find((c) => c.method === "DELETE"));
    expect(del.headers.get("if-match")).toBe('"4"');
    // SKILL.md now refers to a file that's gone.
    expect(
      screen.getByText(/refers to references\/guide.md, which is not in the draft/),
    ).toBeDefined();
  });

  it("lets the author share the draft with team builders", async () => {
    const calls = await opened({
      ...BASE,
      "PATCH /v1/skills/drafts/d-1": [200, { draft: DRAFT(4, { shared: true }) }],
    });
    await userEvent.click(screen.getByRole("switch", { name: "Share with team builders" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Share with team builders" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect([patch.headers.get("if-match"), JSON.parse(patch.body as string)]).toEqual([
      '"3"',
      { shared: true },
    ]);
  });
});

describe("Workbench editor: Save version (ac-3)", () => {
  const SAVED = {
    skill: {
      id: "s-1",
      scope: "personal",
      slug: "report-writer",
      description: "d",
      latest_version: 1,
      latest_semver: "0.1.0",
      owner_user_id: "u-me",
      created_at: "x",
      updated_at: "x",
    },
    version: {
      version: 1,
      semver: "0.1.0",
      content_hash: "h",
      size_bytes: 1,
      file_count: 4,
      uploaded_at: "x",
    },
  };

  it("suggests the bump per destination and saves the revision the author saw, confirmed when asked", async () => {
    const calls = await opened({
      ...BASE,
      "GET /v1/skills/drafts/d-1/bump?destination=team": [
        200,
        {
          rev: 3,
          latest: { skill_id: "t-1", semver: "1.0.0" },
          kind: "minor",
          suggested: "1.1.0",
          reasons: ["SKILL.md instructions changed"],
        },
      ],
      "GET /v1/skills/drafts/d-1/bump?destination=personal": [
        200,
        { rev: 3, latest: null, kind: null, suggested: "0.1.0", reasons: [] },
      ],
      "POST /v1/skills/drafts/d-1/versions": [
        [
          409,
          {
            code: "confirm_personal_required",
            message:
              "This draft has changes by other Finance members; personal skills go with you to every team. Confirm to save it as your personal skill.",
          },
        ],
        [201, SAVED],
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Save report-writer as a version" }),
    );
    expect(
      await dialog.findByText(
        "Suggested: a minor version after 1.0.0, because SKILL.md instructions changed.",
      ),
    ).toBeDefined();
    expect((dialog.getByLabelText("Version") as HTMLInputElement).value).toBe("1.1.0");
    await userEvent.click(dialog.getByRole("radio", { name: /My personal skill/ }));
    expect(await dialog.findByText("A new personal skill: its first version.")).toBeDefined();
    expect((dialog.getByLabelText("Version") as HTMLInputElement).value).toBe("0.1.0");
    await userEvent.click(dialog.getByRole("button", { name: "Save version" }));
    expect(dialog.getByText("Say what changed, in up to 1,024 characters.")).toBeDefined();
    await userEvent.type(dialog.getByLabelText("Changelog"), "First version.");
    await userEvent.click(dialog.getByRole("button", { name: "Save version" }));
    const confirm = await dialog.findByRole("checkbox", {
      name: "Save it as my personal skill anyway",
    });
    await userEvent.click(confirm);
    await userEvent.click(dialog.getByRole("button", { name: "Save version" }));
    expect(
      await screen.findByText("Saved report-writer 0.1.0 as your personal skill."),
    ).toBeDefined();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => [p.headers.get("if-match"), JSON.parse(p.body as string)])).toEqual([
      ['"3"', { destination: "personal", semver: "0.1.0", changelog: "First version." }],
      [
        '"3"',
        {
          destination: "personal",
          semver: "0.1.0",
          changelog: "First version.",
          confirmPersonal: true,
        },
      ],
    ]);
  });

  it("says when there is no suggestion, and starts afresh each time it opens", async () => {
    await opened({
      ...BASE,
      "GET /v1/skills/drafts/d-1/bump?destination=team": [
        503,
        { code: "skills_unavailable", message: "The latest version can't be read right now." },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    let dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(/No suggestion: .*Give the number yourself/)).toBeDefined();
    await userEvent.type(dialog.getByLabelText("Version"), "2.0.0");
    await userEvent.type(dialog.getByLabelText("Changelog"), "Typed.");
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    dialog = within(await screen.findByRole("dialog"));
    expect((dialog.getByLabelText("Version") as HTMLInputElement).value).toBe("");
    expect((dialog.getByLabelText("Changelog") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the number the author typed and shows the server's refusal", async () => {
    const calls = await opened({
      ...BASE,
      "GET /v1/skills/drafts/d-1/bump?destination=team": [
        200,
        {
          rev: 3,
          latest: { skill_id: "t-1", semver: "1.0.0" },
          kind: null,
          suggested: null,
          reasons: [],
        },
      ],
      "POST /v1/skills/drafts/d-1/versions": [
        409,
        { code: "unchanged", message: "That bundle is identical to the current version." },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      await dialog.findByText("Nothing changed since 1.0.0, the latest version."),
    ).toBeDefined();
    await userEvent.type(dialog.getByLabelText("Version"), "1.0.1");
    await userEvent.type(dialog.getByLabelText("Changelog"), "Again.");
    await userEvent.click(dialog.getByRole("button", { name: "Save version" }));
    expect(
      await dialog.findByText("That bundle is identical to the current version."),
    ).toBeDefined();
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(post.body as string)).toMatchObject({ destination: "team", semver: "1.0.1" });
  });
});

describe("Workbench editor: Create file and New folder (KOBE-478)", () => {
  it("creates a file with its contents through the draft file save, and Cancel leaves no file", async () => {
    const calls = await opened({
      ...BASE,
      "PUT /v1/skills/drafts/d-1/files/references/extra.md": [200, { rev: 4, draft: DRAFT(4) }],
    });
    const tree = within(screen.getByRole("navigation", { name: "Files" }));
    await userEvent.click(tree.getByRole("button", { name: "Create file" }));
    await userEvent.type(screen.getByLabelText("New file path"), "notes.md");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New file path")).toBeNull();
    expect(puts(calls)).toHaveLength(0);

    await userEvent.click(tree.getByRole("button", { name: "Create file" }));
    await userEvent.type(screen.getByLabelText("New file path"), "Evals/x.yaml");
    await userEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(screen.getByText(/spell them exactly so/)).toBeDefined();
    expect(puts(calls)).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText("New file path"));
    await userEvent.type(screen.getByLabelText("New file path"), "references/extra.md");
    fireEvent.change(screen.getByLabelText("New file contents"), {
      target: { value: "# Extra\nMore detail." },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save file" }));
    const shown = (await screen.findByLabelText(
      "Contents of references/extra.md",
    )) as HTMLTextAreaElement;
    expect(shown.value).toBe("# Extra\nMore detail.");
    const put = must(puts(calls)[0]);
    expect([put.url, put.headers.get("if-match"), put.body]).toEqual([
      "/v1/skills/drafts/d-1/files/references/extra.md",
      '"3"',
      "# Extra\nMore detail.",
    ]);
    expect(tree.getByRole("button", { name: "references/extra.md" })).toBeDefined();
    // The saved file is scanned like any other write.
    await screen.findByText("Scanned as saved (revision 4).");
    // The new file's text is already in hand: it isn't read back.
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/extra.md"))).toBe(false);
  });

  it("shows the server's refusal (size, rules) and keeps the editor open", async () => {
    await opened({
      ...BASE,
      "PUT /v1/skills/drafts/d-1/files/big.md": [
        413,
        { code: "draft_too_large", message: "The draft is over 5 MiB." },
      ],
    });
    const tree = within(screen.getByRole("navigation", { name: "Files" }));
    await userEvent.click(tree.getByRole("button", { name: "Create file" }));
    await userEvent.type(screen.getByLabelText("New file path"), "big.md");
    await userEvent.click(screen.getByRole("button", { name: "Save file" }));
    await screen.findByText(/over 5 MiB/);
    expect(screen.getByLabelText("New file path")).toBeDefined();
    expect(tree.queryByRole("button", { name: "big.md" })).toBeNull();
  });

  it("adds a validated empty folder, nested ones too, and creates a file in it", async () => {
    const calls = await opened({
      ...BASE,
      "PUT /v1/skills/drafts/d-1/files/templates/forms/a.md": [200, { rev: 4, draft: DRAFT(4) }],
    });
    const tree = within(screen.getByRole("navigation", { name: "Files" }));
    await userEvent.click(tree.getByRole("button", { name: "New folder" }));
    await userEvent.type(tree.getByLabelText("Folder name"), "references");
    await userEvent.click(tree.getByRole("button", { name: "Add folder" }));
    expect(tree.getByText(/A folder already has this name/)).toBeDefined();
    await userEvent.clear(tree.getByLabelText("Folder name"));
    await userEvent.type(tree.getByLabelText("Folder name"), "../up");
    await userEvent.click(tree.getByRole("button", { name: "Add folder" }));
    expect(tree.getByText(/\.\. folder name/)).toBeDefined();
    await userEvent.clear(tree.getByLabelText("Folder name"));
    await userEvent.type(tree.getByLabelText("Folder name"), "templates/forms");
    await userEvent.click(tree.getByRole("button", { name: "Add folder" }));
    expect(tree.getByText("templates/forms/")).toBeDefined();
    expect(tree.getByText("Empty until a file is saved in it.")).toBeDefined();
    // Nothing is stored for a folder: files carry their folder in their path.
    expect(puts(calls)).toHaveLength(0);

    await userEvent.click(tree.getByRole("button", { name: "Create file in templates/forms" }));
    const path = screen.getByLabelText("New file path") as HTMLInputElement;
    expect(path.value).toBe("templates/forms/");
    await userEvent.type(path, "a.md");
    await userEvent.click(screen.getByRole("button", { name: "Save file" }));
    await screen.findByLabelText("Contents of templates/forms/a.md");
    expect(tree.getByRole("button", { name: "templates/forms/a.md" })).toBeDefined();
    expect(tree.queryByText("Empty until a file is saved in it.")).toBeNull();
  });
});

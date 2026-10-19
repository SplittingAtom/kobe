// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteAccess } from "../../lib/admin/nav/types";
import { ConsoleAccessContext } from "./console-context";
import { NOT_READY_NOTICE, SkillReviewQueuePage } from "./site/skill-review-queue";
import { SkillReviewPage } from "./site/skill-review-page";
import { ME, answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "./testing";

/** KOBE-334 (SK22, SK23): the Registry queue and the review screen. */
const BASE = "/v1/site/skills/registry";
const ID = "v-1";

const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  skill: { id: "s-1", name: "sales-report" },
  semver: "0.2.0",
  previous: { id: "v-0", semver: "0.1.0" },
  bump: "minor",
  changed_files: 2,
  state: "submitted",
  verdict: "pass",
  submitted_by: { id: "u-a", name: "Author" },
  submitted_at: "2026-10-19T10:00:00Z",
  claimed_by: null,
  authoritative_scorecard: false,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  id: ID,
  skill: {
    id: "s-1",
    name: "sales-report",
    status: "active",
    maintainers: [{ user_id: "u-a", name: "Author" }],
  },
  semver: "0.2.0",
  state: "submitted",
  previous: { id: "v-0", semver: "0.1.0" },
  bump: "minor",
  verdict: "caution",
  scan: {
    findings: [{ file: "SKILL.md", line: 3, rule: "prerequisite-step" }],
    rules_version: "3",
  },
  findings: [
    {
      key: "prerequisite-step@SKILL.md:3",
      rule: "prerequisite-step",
      file: "SKILL.md",
      line: 3,
      severity: "caution",
      category: "prose",
      acknowledged: null,
    },
  ],
  scorecard: { cases: 5, pass_rate_with: 0.8, lift: 0.2 },
  authoritative_scorecard: null,
  reruns: [],
  manifest: {},
  capabilities: {
    egress: [
      { host: "pypi.org", in_ceiling: true },
      { host: "example.com", in_ceiling: false },
    ],
    packages: {},
  },
  provenance: { from_conversation: true },
  source: { team_name: "Dev", scope: "team" },
  submitted_by: { id: "u-a", name: "Author" },
  confirmed_by: null,
  submitted_at: "2026-10-19T10:00:00Z",
  claimed_by: null,
  self_approved: false,
  similar_names: ["sales-reports"],
  checklist: [
    { id: "instructions_match", label: "The instructions match the description" },
    { id: "no_secrets", label: "No secrets" },
  ],
  events: [
    {
      action: "submitted",
      actor: { id: "u-a", name: "Author" },
      note: null,
      at: "2026-10-19T10:00:00Z",
    },
  ],
  approve_problems: [
    {
      code: "authoritative_scorecard_missing",
      message: "Authoritative scorecard missing: re-run the evals.",
    },
  ],
  ...over,
});

const diff = {
  against: { id: "v-0", semver: "0.1.0" },
  files: [
    {
      path: "SKILL.md",
      status: "changed",
      size: 10,
      binary: false,
      hunks: [
        {
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          lines: ["-old line", "+new line"],
        },
      ],
    },
    { path: "evals/cases.yaml", status: "unchanged", size: 5, binary: false, hunks: [] },
  ],
  changed_files: 1,
  truncated: false,
};

function renderReviewer(ui: React.ReactElement) {
  const access: SiteAccess = {
    console: "site",
    user: ME,
    siteRole: "user",
    grants: ["skill_reviewer"],
  };
  return render(<ConsoleAccessContext.Provider value={access}>{ui}</ConsoleAccessContext.Provider>);
}

beforeEach(() => forbidNativeConfirm());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Registry queue", () => {
  it("lists versions with their bump and changed files, and says when the Registry isn't ready", async () => {
    stubApi({
      [`GET ${BASE}?state=open`]: [200, { items: [item()] }],
      [`GET ${BASE}/status`]: [200, { ready: false, registry_team: null }],
    });
    renderReviewer(<SkillReviewQueuePage />);
    const row = (await screen.findByRole("link", { name: "sales-report" })).closest("tr");
    expect(row?.textContent).toContain("0.2.0");
    expect(row?.textContent).toContain("from 0.1.0, minor");
    expect(within(row as HTMLElement).getByText("2")).toBeTruthy();
    expect(await screen.findByText(NOT_READY_NOTICE)).toBeTruthy();
  });
});

describe("the review screen (ac-1, ac-2)", () => {
  it("opens on the diff, then the evidence; Approve stays off with its reasons", async () => {
    stubApi({
      [`GET ${BASE}/${ID}`]: [200, detail()],
      [`GET ${BASE}/${ID}/diff`]: [200, diff],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    const diffHeading = await screen.findByRole("heading", { name: "Diff" });
    const evidence = screen.getByRole("heading", { name: "Evidence" });
    // The diff comes first in the page.
    expect(
      diffHeading.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(await screen.findByText("+new line")).toBeTruthy();
    expect(screen.getByText(/Against the approved version 0\.1\.0: 1 changed file/)).toBeTruthy();
    expect(screen.getByText("not in the site egress ceiling")).toBeTruthy();
    expect(screen.getByText(/Close to sales-reports/)).toBeTruthy();
    expect(screen.getByText(/No authoritative scorecard yet/)).toBeTruthy();
    expect(screen.getByText("Authoritative scorecard missing: re-run the evals.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    // A Skill reviewer never blocks (SK22).
    expect(screen.queryByRole("button", { name: "Reject and block" })).toBeNull();
  });

  it("asks for a note before Request changes and sends the checklist", async () => {
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [
        [200, detail()],
        [200, detail({ state: "changes_requested" })],
      ],
      [`GET ${BASE}/${ID}/diff`]: [200, diff],
      [`POST ${BASE}/${ID}/decision`]: [200, { id: ID, state: "changes_requested" }],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    expect(await screen.findByText("Write a note for the author first.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.type(screen.getByLabelText("Note"), "Explain the script.");
    await userEvent.click(screen.getByLabelText("No secrets"));
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      action: "request_changes",
      note: "Explain the script.",
      checklist: { instructions_match: false, no_secrets: true },
    });
    expect(await screen.findByText(/Sent back to the author's Workbench/)).toBeTruthy();
  });

  it("lets a Site admin approve, and Reject and block after confirming", async () => {
    const ready = detail({ approve_problems: [], authoritative_scorecard: { cases: 5 } });
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [200, ready],
      [`GET ${BASE}/${ID}/diff`]: [200, diff],
      [`POST ${BASE}/${ID}/decision`]: [200, { id: ID, state: "rejected" }],
    });
    renderSite(<SkillReviewPage versionId={ID} />, "admin");
    expect((await screen.findByRole("button", { name: "Approve" })).hasAttribute("disabled")).toBe(
      false,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject and block" }));
    await answerConfirm(/block its hash everywhere/, "Reject and block");
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toMatchObject({ action: "reject_and_block" });
  });

  it("claims an unclaimed version", async () => {
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [
        [200, detail()],
        [200, detail({ state: "in_review", claimed_by: { id: ME.id, name: ME.name } })],
      ],
      [`GET ${BASE}/${ID}/diff`]: [200, diff],
      [`POST ${BASE}/${ID}/claim`]: [200, { id: ID, state: "in_review" }],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Claim" }));
    expect(await screen.findByRole("button", { name: "Let go" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${BASE}/${ID}/claim`,
    ]);
  });

  it("acknowledges a Caution finding", async () => {
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [200, detail()],
      [`GET ${BASE}/${ID}/diff`]: [200, diff],
      [`POST ${BASE}/${ID}/acknowledgements`]: [
        200,
        { finding: "prerequisite-step@SKILL.md:3", acknowledged: true },
      ],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Acknowledge prerequisite-step in SKILL.md line 3",
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/acknowledgements"))?.body).toBe(
        JSON.stringify({ finding: "prerequisite-step@SKILL.md:3" }),
      ),
    );
  });

  it("re-runs the evals in the Registry team and shows the latest run (KOBE-335)", async () => {
    const entry = (over: Record<string, unknown>) => ({
      eval_run_id: "e-0",
      started_by: { id: "u-r", name: "Rae" },
      started_at: "2026-10-19T11:00:00Z",
      status: "completed",
      cancelled_by: null,
      progress: { done: 5, total: 5 },
      pass_rate: 0.4,
      lift: 0,
      current: false,
      lower_than_current: true,
      ...over,
    });
    const running = detail({
      reruns: [
        entry({}),
        entry({
          eval_run_id: "e-1",
          status: "running",
          progress: { done: 1, total: 5 },
          pass_rate: null,
          lower_than_current: false,
        }),
      ],
    });
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [
        [200, detail()],
        [200, running],
      ],
      [`GET ${BASE}/${ID}/diff`]: [200, diff],
      [`POST ${BASE}/${ID}/rerun-evals`]: [202, { eval_run_id: "e-1" }],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Re-run evals" }));
    expect(await screen.findByText("scored lower")).toBeTruthy();
    expect(screen.getByText(/running \(1 of 5\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel re-run" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-run evals" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${BASE}/${ID}/rerun-evals`,
    ]);
  });

  it("loads a skipped file's diff and shows a too-large file whole (review-335 M2)", async () => {
    const skippedDiff = {
      ...diff,
      truncated: true,
      files: [
        {
          path: "SKILL.md",
          status: "changed",
          size: 10,
          binary: false,
          not_diffed: "skipped",
          hunks: [],
        },
        {
          path: "data.csv",
          status: "changed",
          size: 9,
          binary: false,
          not_diffed: "too_large",
          hunks: [],
        },
      ],
    };
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [200, detail()],
      [`GET ${BASE}/${ID}/diff`]: [200, skippedDiff],
      [`GET ${BASE}/${ID}/diff?path=SKILL.md`]: [
        200,
        {
          path: "SKILL.md",
          status: "changed",
          size: 10,
          binary: false,
          hunks: [
            { old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["+loaded line"] },
          ],
        },
      ],
      [`GET ${BASE}/${ID}/file?path=data.csv`]: [
        200,
        {
          path: "data.csv",
          size: 9,
          sha256: "ab".repeat(32),
          encoding: "text",
          text: "a,b\u202E\n",
          truncated: false,
        },
      ],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Load diff of SKILL.md" }));
    expect(await screen.findByText("+loaded line")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "View data.csv" }));
    expect(await screen.findByText("⟨U+202E⟩")).toBeTruthy();
    expect(screen.getByText("ab".repeat(32))).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`${BASE}/${ID}/file?path=data.csv`);
  });

  it("reads a script with a bad byte whole, escaped, and flags it (review-336 M1)", async () => {
    const calls = stubApi({
      [`GET ${BASE}/${ID}`]: [200, detail()],
      [`GET ${BASE}/${ID}/diff`]: [
        200,
        {
          ...diff,
          files: [{ path: "scripts/run.sh", status: "changed", size: 9, binary: true, hunks: [] }],
        },
      ],
      [`GET ${BASE}/${ID}/file?path=scripts%2Frun.sh`]: [
        200,
        {
          path: "scripts/run.sh",
          size: 9,
          sha256: "cd".repeat(32),
          encoding: "hex",
          text: "00000000  00 41",
          truncated: true,
        },
      ],
    });
    renderReviewer(<SkillReviewPage versionId={ID} />);
    expect(await screen.findByText(/code that isn.t plain text/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "View scripts/run.sh" }));
    expect(await screen.findByText(/Hex dump/)).toBeTruthy();
    expect(screen.getByText(/Only the beginning of scripts\/run.sh is shown/)).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`${BASE}/${ID}/file?path=scripts%2Frun.sh`);
  });
});

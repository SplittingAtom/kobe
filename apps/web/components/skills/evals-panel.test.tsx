// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillEvalScorecard } from "@kobe/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTeam, stubApi } from "../admin/testing";
import { EvalScorecard, evalThreadHref } from "./eval-scorecard";
import { CASES_PATH, EvalsPanel } from "./evals-panel";
import type { DraftEditor } from "./use-draft-editor";

/**
 * KOBE-328: the scorecard shows every metric with a link per case run (ac-1), suggestions add a
 * negative trigger case (ac-2), and the history lists each revision's evals (ac-3).
 */
const GOLDEN = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../../packages/protocol/src/skill-evals/fixtures/scorecard/valid-full.json",
    ),
    "utf8",
  ),
) as SkillEvalScorecard;

const run = (over: Record<string, unknown>) => ({
  id: "e-1",
  subject: { kind: "draft", draftId: "d-1", rev: 3 },
  packageHash: GOLDEN.packageHash,
  mode: "full",
  status: "completed",
  progress: { done: 5, total: 5 },
  scorecard: GOLDEN,
  failure: null,
  startedBy: "u-1",
  startedAt: "2026-10-18T10:00:00.000Z",
  finishedAt: "2026-10-18T10:05:00.000Z",
  ...over,
});
const ESTIMATE = {
  estimate: { executions: 5, cost_usd: 0.4, minutes: 3, basis: "team_history" },
  run_model: { requested: null, used: "smart", fell_back: false },
  blocked: null,
};
const SKILL = `---\nname: sales-report\ndescription: "Builds the sales workbook. Use when asked for a sales report or a revenue summary."\n---\n# Body\n`;

function editor(over: Partial<DraftEditor> = {}): DraftEditor {
  return {
    draft: {
      id: "d-1",
      name: "sales-report",
      rev: 4,
      mine: true,
      shared: false,
    } as DraftEditor["draft"],
    files: [{ path: "SKILL.md" }] as unknown as DraftEditor["files"],
    texts: { "SKILL.md": SKILL },
    status: "saved",
    error: null,
    scan: { status: "idle" } as DraftEditor["scan"],
    edit: vi.fn(),
    open: vi.fn(async () => null),
    addFile: vi.fn(async () => null),
    removeFile: vi.fn(async () => null),
    share: vi.fn(async () => null),
    flush: vi.fn(async () => 4),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the scorecard (ac-1)", () => {
  it("shows every metric, both modes and a link to each case's runs", () => {
    render(<EvalScorecard card={GOLDEN} />);
    const card = screen.getByLabelText("Scorecard");
    for (const label of [
      "Pass rate",
      "Baseline pass rate",
      "Lift",
      "Trigger precision",
      "Trigger recall",
      "Cost",
      "Cases",
      "Run model",
      "Judge",
    ])
      expect(within(card).getByText(label, { selector: "dt" })).toBeDefined();
    expect(within(card).getByText("+100 points")).toBeDefined();
    expect(within(card).getByText("$0.82 runs + $0.01 judge")).toBeDefined();
    expect(within(card).getByText("smart (the Site's judge)")).toBeDefined();
    expect(within(card).getByRole("rowheader", { name: "With the skill" })).toBeDefined();
    expect(within(card).getByRole("rowheader", { name: "Without (baseline)" })).toBeDefined();
    for (const d of GOLDEN.details) expect(within(card).getByText(d.caseId)).toBeDefined();
    const links = within(card).getAllByRole("link", { name: "Open the run" });
    const threads = GOLDEN.details.flatMap((d) => [d.with, d.without]).filter((e) => e?.threadId);
    expect(links).toHaveLength(threads.length);
    expect(links[0]?.getAttribute("href")).toBe(
      evalThreadHref(GOLDEN.details[0]?.with.threadId ?? ""),
    );
  });

  it("says why there is no lift, and a run model the team hasn't enabled", () => {
    const card = {
      ...GOLDEN,
      lift: null,
      liftUnavailable: "incomplete_pairs",
      runModel: { requested: "huge", used: "smart", fellBack: true },
    } as SkillEvalScorecard;
    render(<EvalScorecard card={card} />);
    expect(screen.getByText("— (a baseline run errored)")).toBeDefined();
    expect(
      screen.getByText("smart (the suite asks for huge, which the team hasn't enabled)"),
    ).toBeDefined();
  });
});

describe("the evals panel", () => {
  it("ac-2: suggests cases with at least one that should not trigger into a new cases file", async () => {
    stubApi({ "GET /v1/skill-evals?draft_id=d-1": [200, { evals: [] }] });
    const ed = editor();
    renderTeam(<EvalsPanel teamId="t-1" editor={ed} />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest trigger cases" }));
    await waitFor(() => expect(ed.edit).toHaveBeenCalled());
    expect(ed.addFile).toHaveBeenCalledWith(CASES_PATH);
    const [path, text] = vi.mocked(ed.edit).mock.calls[0] ?? [];
    expect(path).toBe(CASES_PATH);
    expect(text).toContain("triggers: false");
    expect(text).toContain("triggers: true");
    expect(screen.getByRole("status").textContent).toMatch(/that should not trigger/);
  });

  it("ac-3: lists the draft's evals by revision, shows live progress and the picked scorecard", async () => {
    stubApi({
      "GET /v1/skill-evals?draft_id=d-1": [
        200,
        {
          evals: [
            run({
              id: "e-2",
              status: "running",
              scorecard: null,
              progress: { done: 1, total: 5 },
              subject: { kind: "draft", draftId: "d-1", rev: 4 },
              finishedAt: null,
            }),
            run({ id: "e-1" }),
          ],
        },
      ],
      "GET /v1/skills/drafts/d-1/evals/estimate?mode=full": [200, ESTIMATE],
    });
    const ed = editor({
      files: [{ path: "SKILL.md" }, { path: CASES_PATH }] as unknown as DraftEditor["files"],
    });
    renderTeam(<EvalsPanel teamId="t-1" editor={ed} />);
    const history = await screen.findByRole("table", { name: "Eval history" });
    expect(within(history).getByText("revision 4")).toBeDefined();
    expect(within(history).getByText("revision 3")).toBeDefined();
    expect(within(history).getByText("Running (1 of 5)")).toBeDefined();
    // The newest completed eval is shown by default; picking the running one shows its progress.
    expect(screen.getByLabelText("Eval of revision 3")).toBeDefined();
    const rows = within(history).getAllByRole("button", { name: "Show" });
    await userEvent.click(rows[0] as HTMLElement);
    expect((await screen.findByLabelText("Eval of revision 4")).textContent).toContain(
      "1 of 5 runs done",
    );
  });

  it("shows why a budget-stopped eval ended", async () => {
    stubApi({
      "GET /v1/skill-evals?draft_id=d-1": [
        200,
        {
          evals: [
            run({
              status: "budget_stopped",
              scorecard: null,
              failure: {
                code: "eval_cap_reached",
                message: "Your team's monthly eval cap ($5.00) is used up.",
              },
            }),
          ],
        },
      ],
    });
    renderTeam(<EvalsPanel teamId="t-1" editor={editor()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect(
      await screen.findByText("Your team's monthly eval cap ($5.00) is used up."),
    ).toBeDefined();
  });
});

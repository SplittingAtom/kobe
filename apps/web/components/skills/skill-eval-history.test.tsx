// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillEvalScorecard } from "@kobe/protocol";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillAdminPage } from "../admin/team/skill-editor/skill-admin-page";
import { renderTeam, stubApi } from "../admin/testing";
import { EvalRunPage } from "./eval-run-page";
import { SkillEvalHistory, byVersion } from "./skill-eval-history";

/** KOBE-328 ac-3: eval scorecards per saved version, each linking to its full scorecard. */
const GOLDEN = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../../packages/protocol/src/skill-evals/fixtures/scorecard/valid-full.json",
    ),
    "utf8",
  ),
) as SkillEvalScorecard;

const run = (id: string, seq: number, over: Record<string, unknown> = {}) => ({
  id,
  subject: { kind: "version", scope: "team", skillId: "s-1", seq },
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
const HISTORY = {
  evals: [
    run("e-3", 2, { status: "running", scorecard: null, progress: { done: 2, total: 5 } }),
    run("e-2", 2),
    run("e-1", 1, { mode: "with_only" }),
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("eval history per saved version", () => {
  it("groups each version's evals, newest version first, each linking to its scorecard", async () => {
    stubApi({ "GET /v1/skill-evals?scope=team&skill_id=s-1": [200, HISTORY] });
    renderTeam(
      <SkillEvalHistory
        teamId="t-1"
        scope="team"
        skillId="s-1"
        semverOf={(seq) => (seq === 2 ? "0.2.0" : undefined)}
      />,
    );
    const tables = await screen.findAllByRole("table");
    expect(tables.map((t) => t.querySelector("caption")?.textContent)).toEqual([
      "v0.2.0",
      "Version 1",
    ]);
    const v2 = must(tables[0]);
    expect(within(v2).getAllByRole("row")).toHaveLength(3);
    expect(within(v2).getByText("Running (2 of 5)")).toBeDefined();
    expect(within(v2).getAllByText("100 %").length).toBeGreaterThan(0);
    expect(within(v2).getByText("+100 points")).toBeDefined();
    const links = within(v2).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/me/skills/evals/e-3",
      "/me/skills/evals/e-2",
    ]);
    expect(within(must(tables[1])).getByText("Skill only")).toBeDefined();
  });

  it("says when no version was evaluated, and leaves draft evals out", async () => {
    stubApi({
      "GET /v1/skill-evals?scope=team&skill_id=s-1": [
        200,
        { evals: [{ ...run("e-9", 1), subject: { kind: "draft", draftId: "d-1", rev: 2 } }] },
      ],
    });
    renderTeam(<SkillEvalHistory teamId="t-1" scope="team" skillId="s-1" />);
    expect(
      await screen.findByText("No saved version of this skill has been evaluated yet."),
    ).toBeDefined();
    expect(byVersion([])).toEqual([]);
  });

  it("is on the team skill's view", async () => {
    stubApi({
      "GET /v1/skills/s-1": [
        200,
        {
          skill: {
            id: "s-1",
            scope: "team",
            slug: "report-writer",
            description: "Writes reports.",
            latest_version: 2,
            latest_semver: "0.2.0",
            owner_user_id: "u-me",
            created_at: "2026-10-01T10:00:00Z",
            updated_at: "2026-10-02T10:00:00Z",
          },
        },
      ],
      "GET /v1/skills/s-1/reach": [
        200,
        { offer_to_all: false, access: "available", approved: true, agents: [] },
      ],
      "GET /v1/skills/s-1/usage": [200, { uses: 0, last_used_at: null, agents: [] }],
      "GET /v1/skill-evals?scope=team&skill_id=s-1": [200, HISTORY],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />);
    expect(await screen.findByRole("heading", { name: "Evals by version" })).toBeDefined();
    expect(await screen.findByText("v0.2.0", { selector: "caption" })).toBeDefined();
    expect(screen.getByText("Version 1", { selector: "caption" })).toBeDefined();
  });
});

describe("one eval's full scorecard", () => {
  it("opens the scorecard of the linked eval", async () => {
    stubApi({ "GET /v1/skill-evals/e-2": [200, run("e-2", 2)] });
    renderTeam(<EvalRunPage evalRunId="e-2" />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Eval of version 2" }),
    ).toBeDefined();
    expect(screen.getByLabelText("Scorecard")).toBeDefined();
  });

  it("explains an eval that stopped", async () => {
    stubApi({
      "GET /v1/skill-evals/e-4": [
        200,
        run("e-4", 2, {
          status: "budget_stopped",
          scorecard: null,
          failure: {
            code: "budget_exhausted",
            message: "Your team's monthly model budget is used up.",
          },
        }),
      ],
    });
    renderTeam(<EvalRunPage evalRunId="e-4" />);
    expect(await screen.findByText("Your team's monthly model budget is used up.")).toBeDefined();
  });
});

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}

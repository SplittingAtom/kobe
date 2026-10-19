// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillEvalScorecard } from "@kobe/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillAdminPage } from "../admin/team/skill-editor/skill-admin-page";
import { FakeEvalStream, breakStream } from "../../lib/skills/testing/fake-event-source";
import {
  EVAL_POLL_MS,
  MAX_POLL_FAILURES,
  STALLED_MESSAGE,
  STREAM_RETRIES,
  STREAM_RETRY_MS,
} from "../../lib/skills/use-live-eval";
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
    expect(await screen.findByRole("region", { name: "Eval of version 2" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Scorecard" })).toBeDefined();
  });

  it("follows a running eval on its stream until it completes", async () => {
    const stream = new FakeEvalStream();
    const calls = stubApi({
      "GET /v1/skill-evals/e-5": [
        [
          200,
          run("e-5", 2, { status: "running", scorecard: null, progress: { done: 1, total: 5 } }),
        ],
        [200, run("e-5", 2)],
      ],
    });
    renderTeam(<EvalRunPage evalRunId="e-5" eventSource={stream.factory} />);
    expect(await screen.findByText(/1 of 5 runs done/)).toBeDefined();
    await waitFor(() => expect(stream.urls).toEqual(["/v1/skill-evals/e-5/events"]));
    must(stream.sources[0]).emit("skill.eval.completed", { status: "completed" });
    expect(await screen.findByRole("region", { name: "Scorecard" })).toBeDefined();
    expect(must(stream.sources[0]).closed).toBe(true);
    expect(calls.filter((c) => c.url === "/v1/skill-evals/e-5")).toHaveLength(2);
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

describe("when live progress gives up", () => {
  it("says so on the eval page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const stream = new FakeEvalStream();
      stubApi({
        "GET /v1/skill-evals/e-6": [
          [
            200,
            run("e-6", 2, { status: "running", scorecard: null, progress: { done: 1, total: 5 } }),
          ],
          [500, { code: "internal", message: "down" }],
        ],
      });
      renderTeam(<EvalRunPage evalRunId="e-6" eventSource={stream.factory} />);
      await screen.findByText(/1 of 5 runs done/);
      await waitFor(() => expect(stream.sources).toHaveLength(1));
      await breakStream(
        stream,
        (ms) => vi.advanceTimersByTimeAsync(ms),
        STREAM_RETRIES,
        STREAM_RETRY_MS,
      );
      await vi.advanceTimersByTimeAsync(EVAL_POLL_MS * (MAX_POLL_FAILURES + 1));
      expect(await screen.findByText(STALLED_MESSAGE)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

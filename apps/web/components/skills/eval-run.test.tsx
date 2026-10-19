// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateText } from "../../lib/skills/evals-api";
import { must } from "../../lib/testing/must";
import { renderTeam, stubApi } from "../admin/testing";
import { EvalRun } from "./eval-run";

/** KOBE-327 ac-2, ac-3: the estimate before Run, and a cap that refuses the start says why. */
const MEMBER = { role: "member", permissions: [] } as const;
const ESTIMATE = (blocked: unknown = null) => ({
  estimate: { executions: 8, cost_usd: 0.42, minutes: 6, basis: "team_history" },
  run_model: { requested: null, used: "fast", fell_back: false },
  blocked,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Run evals (Workbench)", () => {
  it("shows the estimate before Run, then starts the eval after saving pending edits", async () => {
    const calls = stubApi({
      "GET /v1/skills/drafts/d-1/evals/estimate?mode=full": [200, ESTIMATE()],
      "GET /v1/skills/drafts/d-1/evals/estimate?mode=with_only": [
        200,
        { ...ESTIMATE(), estimate: { ...ESTIMATE().estimate, executions: 5 } },
      ],
      "POST /v1/skills/drafts/d-1/evals": [
        202,
        { eval_run_id: "e-1", estimate: ESTIMATE().estimate },
      ],
    });
    const flush = vi.fn(async () => null);
    renderTeam(<EvalRun teamId="t-1" draftId="d-1" rev={3} flush={flush} />, MEMBER);
    expect((await screen.findByLabelText("Estimate")).textContent).toBe(
      "≈ $0.42, ≈ 6 min · 8 runs",
    );
    await userEvent.click(screen.getByLabelText("Compare with a no-skill baseline"));
    await waitFor(() => expect(screen.getByLabelText("Estimate").textContent).toContain("5 runs"));
    await userEvent.click(screen.getByRole("button", { name: "Run evals" }));
    await screen.findByText("Eval started.");
    expect(flush).toHaveBeenCalled();
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(post.body as string)).toEqual({ mode: "with_only" });
  });

  it("shows why a start would be refused instead of the button", async () => {
    const message =
      "Your team's monthly eval cap ($5.00) is used up: $5.10 spent on evals this month. A Team admin can raise or remove it.";
    stubApi({
      "GET /v1/skills/drafts/d-1/evals/estimate?mode=full": [
        200,
        ESTIMATE({ code: "eval_cap_reached", message }),
      ],
    });
    renderTeam(<EvalRun teamId="t-1" draftId="d-1" rev={1} flush={async () => null} />, MEMBER);
    expect(await screen.findByText(message)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Run evals" })).toBeNull();
  });

  it("words an estimate without history or prices", () => {
    expect(estimateText({ executions: 1, costUsd: null, minutes: null, basis: "none" })).toBe(
      "1 run · no estimate yet (the team has no history on this model)",
    );
    expect(estimateText({ executions: 2, costUsd: null, minutes: 3, basis: "team_history" })).toBe(
      "cost unknown (unpriced model), ≈ 3 min · 2 runs",
    );
    expect(
      estimateText({ executions: 2, costUsd: 0.0031, minutes: 1, basis: "team_history" }),
    ).toBe("≈ $0.0031, ≈ 1 min · 2 runs");
  });
});

// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEval, EvalCaseCounts } from "../../lib/admin/api/team/agent-builder";
import { blockedByCases, caseOutcome, caseSkips } from "../../lib/admin/eval-case-counts";
import { EvalReportPage } from "./team/agent-builder/eval-report";
import { EvalStatus } from "./team/agent-builder/eval-status";
import { forbidNativeConfirm, renderTeam, stubApi, TEAM } from "./testing";

const counts = (over: Partial<EvalCaseCounts> = {}): EvalCaseCounts => ({
  total: 2,
  scored: 2,
  failed: 1,
  failureRate: 0.5,
  skipped: {},
  ...over,
});

const evalOf = (over: Partial<AgentEval> = {}): AgentEval => ({
  id: "e-1",
  status: "blocked",
  draftRevision: 3,
  threshold: 0.1,
  attackSuccessRate: 0.05,
  attempts: 20,
  attackSuccesses: 1,
  cases: counts(),
  error: null,
  version: null,
  createdAt: "2026-10-17T10:00:00Z",
  startedAt: "2026-10-17T10:00:00Z",
  finishedAt: "2026-10-17T10:05:00Z",
  ...over,
});

const noop = () => undefined;

function renderStatus(started: AgentEval) {
  return renderTeam(
    <EvalStatus
      teamId={TEAM.id}
      agentId="a-1"
      started={started}
      canRetry={false}
      onActiveChange={noop}
      onFinished={noop}
      onRetry={noop}
    />,
  );
}

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("how shared cases counted in the gate (KOBE-276)", () => {
  it("words the outcome, the skips and where a block came from", () => {
    expect(caseOutcome(undefined, 0.1)).toBeNull();
    expect(
      caseOutcome(counts({ total: 0, scored: 0, failed: 0, failureRate: null }), 0.1),
    ).toBeNull();
    expect(caseOutcome(counts(), 0.1)).toBe(
      "1 of 2 shared cases failed (50%); the team's limit is 10%.",
    );
    expect(
      caseOutcome(counts({ total: 1, scored: null, failed: null, failureRate: null }), 0),
    ).toBe("1 shared case in this evaluation.");
    expect(caseSkips(counts({ skipped: { noReviewer: 2, other: 0 } }))).toEqual([
      "2 accepted cases were left out: the agent's owner can't review cases now (they left the team or may no longer build agents).",
    ]);
    expect(caseSkips(counts({ skipped: { somethingNew: 1 } }))).toEqual([
      "1 accepted case was left out.",
    ]);
    expect(blockedByCases(evalOf())).toBe(true);
    expect(blockedByCases(evalOf({ attackSuccessRate: 0.2 }))).toBe(false);
    expect(blockedByCases(evalOf({ status: "passed" }))).toBe(false);
  });

  it("the builder says a block came from the cases when attacks stayed within the limit", () => {
    renderStatus(evalOf({ cases: counts({ skipped: { noReviewer: 1 } }) }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Blocked by the shared cases/);
    expect(alert.textContent).toMatch(/Shared cases: 1 of 2 shared cases failed \(50%\)/);
    expect(alert.textContent).toMatch(/1 accepted case was left out: the agent's owner/);
  });

  it("an attack block stays an attack block, with the cases' outcome beside it", () => {
    renderStatus(evalOf({ attackSuccessRate: 0.3, cases: counts({ failed: 0, failureRate: 0 }) }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Change the agent to resist these attacks/);
    expect(alert.textContent).toMatch(/0 of 2 shared cases failed/);
  });

  it("a pass lists the cases; an eval without cases says nothing about them", () => {
    renderStatus(
      evalOf({ status: "passed", version: 4, cases: counts({ failed: 0, failureRate: 0 }) }),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /Published as v4\.Shared cases: 0 of 2 shared cases failed/,
    );
    cleanup();
    const { cases: _omitted, ...withoutCases } = evalOf({ status: "passed", version: 4 });
    renderStatus(withoutCases);
    expect(screen.getByRole("status").textContent).not.toMatch(/Shared cases/);
  });

  it("the eval report shows the cases' counts", async () => {
    stubApi({
      "GET /v1/agents/a-1/evals/e-1": [
        200,
        { eval: { ...evalOf(), cases: { ...counts(), skipped: { no_reviewer: 1 } } } },
      ],
    });
    renderTeam(<EvalReportPage agentId="a-1" evalId="e-1" />);
    expect(await screen.findByText("Shared cases")).toBeTruthy();
    expect(screen.getByText(/1 of 2 shared cases failed \(50%\)/)).toBeTruthy();
    expect(screen.getByText(/1 accepted case was left out: the agent's owner/)).toBeTruthy();
  });
});

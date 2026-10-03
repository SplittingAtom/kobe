// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KobeEventPayload } from "@kobe/protocol";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { ApprovalCard } from "./approval-card";
import { composer, openApp, streaming } from "./testing";

/**
 * The approval card (KOBE-37, U6) in the chat over the fake server: what it shows, Allow with
 * "always allow", Deny, expiry and errors. The server decides and signs; the card only asks.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const APPROVAL = "00000000-0000-4000-8000-000900000001";
const TOOL = "mcp__jira__create_issue";

function asked(overrides: Partial<KobeEventPayload<"approval.requested">> = {}) {
  return {
    approval_id: APPROVAL,
    tool_call_id: "tc1",
    tool: TOOL,
    input: { project: "OPS", summary: "Rotate keys" },
    risk: "write" as const,
    reasons: [
      {
        code: "risk_write" as const,
        stage: "risk_class" as const,
        message: "Creating a Jira issue changes data outside Kobe.",
      },
    ],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

/** A thread with a run whose Jira call waits for approval. */
async function waitingRun() {
  const t = fake.addThread("Ops");
  openApp(fake, t);
  const user = userEvent.setup();
  await user.type(await composer(), "file a ticket{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  fake.agent.toolCall(runId, "tc1", TOOL, { project: "OPS", summary: "Rotate keys" }, "m1");
  fake.requestApproval(runId, asked());
  await screen.findByRole("group", { name: /Approval needed/ });
  return { user, runId };
}

const decisions = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v1/approvals/"));

describe("approval card", () => {
  it("shows the tool, its risk, why, the exact input and the expiry", async () => {
    await waitingRun();
    const card = screen.getByRole("group", { name: /Approval needed/ });
    expect(card.textContent).toContain(TOOL);
    expect(card.textContent).toContain("Changes data");
    expect(card.textContent).toContain("Creating a Jira issue changes data outside Kobe.");
    expect(screen.getByLabelText("Input to approve").textContent).toContain(
      '"summary": "Rotate keys"',
    );
    expect(card.textContent).toMatch(/Expires at/);
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
  });

  it("Allow with 'always allow' posts the remember-rule for exactly this tool, then shows it", async () => {
    const { user } = await waitingRun();
    await user.click(screen.getByRole("checkbox", { name: /Always allow/ }));
    await user.selectOptions(screen.getByLabelText("Remember for"), "for 30 days");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText(/Approved\. Kobe will not ask again/);
    expect(decisions()).toEqual([
      expect.objectContaining({
        path: `/v1/approvals/${APPROVAL}`,
        team: fake.teamId,
        body: { decision: "allow", remember: { tool_glob: TOOL, expires_in: 30 * 24 * 3600 } },
      }),
    ]);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText("Waiting for approval")).toBeNull();
  });

  it("Deny says the tool did not run; remember is never sent with a deny", async () => {
    const { user } = await waitingRun();
    await user.click(screen.getByRole("checkbox", { name: /Always allow/ }));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await screen.findByText("Denied. The tool did not run.");
    expect(decisions().map((r) => r.body)).toEqual([{ decision: "deny" }]);
  });

  it("an expiry from the server ends the card visibly", async () => {
    const { runId } = await waitingRun();
    fake.emit(runId, "approval.resolved", {
      approval_id: APPROVAL,
      tool_call_id: "tc1",
      decision: "expired",
      cause: "ttl",
      remembered: false,
    });
    await screen.findByText(/expired after 1 hour without an answer/);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("shows the server's refusal and keeps the buttons", async () => {
    const { user } = await waitingRun();
    fake.failNext.set(
      `POST /v1/approvals/${APPROVAL}`,
      new Response(
        JSON.stringify({
          code: "approval_not_found",
          message: "No pending approval with that id.",
        }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No pending approval with that id.",
    );
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});

describe("ApprovalCard", () => {
  const api = {
    decideApproval: vi.fn(),
    getApproval: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        data: { input: { from: "server" } } as never,
      }),
    ),
  };

  it("offers no buttons once the request is past its expiry", () => {
    render(
      <ApprovalCard
        requested={asked({ expires_at: "2026-10-03T10:00:00.000Z" })}
        resolved={undefined}
        api={api}
        now={() => Date.parse("2026-10-03T10:00:01.000Z")}
      />,
    );
    expect(screen.getByText(/This approval request expired/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps Allow off until the exact input is loaded, and while it can't be", async () => {
    let answer: (v: unknown) => void = () => undefined;
    const slow = {
      decideApproval: vi.fn(),
      getApproval: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
        .mockImplementationOnce(() =>
          Promise.resolve({
            ok: true as const,
            status: 200,
            data: { input: { from: "server" } } as never,
          }),
        ),
    };
    render(<ApprovalCard requested={asked({ input: {} })} resolved={undefined} api={slow} />);
    expect(screen.getByText("Loading the exact input…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    answer({ ok: false, error: { status: 0, code: "network_error", message: "down" } });
    await screen.findByText(/could not be loaded/);
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Input to approve").textContent).toContain('"from": "server"'),
    );
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("reads the exact input back when a resumed stream dropped it", async () => {
    render(<ApprovalCard requested={asked({ input: {} })} resolved={undefined} api={api} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Input to approve").textContent).toContain('"from": "server"'),
    );
    expect(api.getApproval).toHaveBeenCalledWith(APPROVAL);
  });

  it.each([
    ["run_cancelled", /run was stopped/],
    ["budget_exhausted", /budget is used up/],
    ["run_interrupted", /interrupted/],
  ] as const)("explains an expiry caused by %s", (cause, text) => {
    render(
      <ApprovalCard
        requested={asked()}
        resolved={{
          approval_id: APPROVAL,
          tool_call_id: "tc1",
          decision: "expired",
          cause,
          remembered: false,
        }}
        api={api}
      />,
    );
    expect(screen.getByText(text)).toBeTruthy();
  });
});

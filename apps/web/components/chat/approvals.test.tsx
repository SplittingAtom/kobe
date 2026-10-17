// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("Allow with 'remember' posts the scope the member chose for exactly this tool", async () => {
    const { user } = await waitingRun();
    const box = await screen.findByRole("checkbox", { name: /Remember: allow/ });
    await user.click(box);
    await user.selectOptions(screen.getByLabelText("Remember for"), "this conversation");
    expect(screen.getByText("Ends with this conversation.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText(/Approved and remembered\. You can revoke it in My area, Approvals\./);
    expect(decisions()).toEqual([
      expect.objectContaining({
        path: `/v1/approvals/${APPROVAL}`,
        team: fake.teamId,
        body: { decision: "allow", remember: { tool_glob: TOOL, scope: "thread" } },
      }),
    ]);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText("Waiting for approval")).toBeNull();
  });

  it("Deny says the tool did not run; remember is never sent with a deny", async () => {
    const { user } = await waitingRun();
    await user.click(await screen.findByRole("checkbox", { name: /Remember: allow/ }));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await screen.findByText("Denied. The tool did not run.");
    expect(decisions().map((r) => r.body)).toEqual([{ decision: "deny" }]);
  });

  it("offers only the choices the server allows (the team's limits), nothing else", async () => {
    fake.rememberOptions = (id) => ({
      approval_id: id,
      run_id: "r",
      can_remember: true,
      reason: null,
      choices: [
        { scope: "thread", label: "this conversation", expires_at: null },
        { scope: "today", label: "until end of today", expires_at: "2026-10-17T22:00:00.000Z" },
      ],
      time_zone: "Europe/Berlin",
      exact: null,
      exact_only: false,
      approve_all: null,
      approve_all_reason: "Only one approval is waiting in this run.",
    });
    const { user } = await waitingRun();
    await user.click(await screen.findByRole("checkbox", { name: /Remember: allow/ }));
    const select = screen.getByLabelText("Remember for") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "this conversation",
      "until end of today",
    ]);
    await user.selectOptions(select, "until end of today");
    expect(screen.getByText(/Ends at midnight \(Europe\/Berlin\)/)).toBeTruthy();
    // No exact pattern from the server: the choice isn't offered.
    expect(screen.queryByRole("checkbox", { name: /Only this exact action/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve all waiting/ })).toBeNull();
  });

  it("shows the reason instead when the team allows no remembering", async () => {
    fake.rememberOptions = (id) => ({
      approval_id: id,
      run_id: "r",
      can_remember: false,
      reason: "Your team doesn't allow remembering this approval.",
      choices: [],
      time_zone: "UTC",
      exact: null,
      exact_only: false,
      approve_all: null,
      approve_all_reason: null,
    });
    await waitingRun();
    await screen.findByText("Your team doesn't allow remembering this approval.");
    expect(screen.queryByRole("checkbox", { name: /Remember/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("'only this exact action' shows the server's pattern before saving and asks for it", async () => {
    const { user } = await waitingRun();
    await user.click(await screen.findByRole("checkbox", { name: /Remember: allow/ }));
    await user.click(screen.getByRole("checkbox", { name: /Only this exact action/ }));
    const shown = screen.getByRole("list", { name: "Exact action to remember" });
    expect(shown.textContent).toContain("/project is exactly OPS");
    expect(shown.textContent).toContain("/summary is exactly Rotate keys");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText(/Approved and remembered/);
    expect(decisions().map((r) => r.body)).toEqual([
      { decision: "allow", remember: { tool_glob: TOOL, scope: "thread", exact: true } },
    ]);
  });

  it("exact-only teams: the exact choice is ticked and can't be unticked", async () => {
    const base = fake.rememberOptions;
    fake.rememberOptions = (id) => ({ ...base(id), exact_only: true });
    const { user } = await waitingRun();
    await user.click(await screen.findByRole("checkbox", { name: /Remember: allow/ }));
    const exact = screen.getByRole("checkbox", {
      name: /Only this exact action/,
    }) as HTMLInputElement;
    expect(exact.checked).toBe(true);
    expect(exact.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText(/Approved and remembered/);
    expect(decisions()[0]?.body).toMatchObject({ remember: { exact: true } });
  });

  it("'Approve all waiting' allows every waiting call of the run after confirming", async () => {
    const { user, runId } = await waitingRun();
    fake.agent.toolCall(runId, "tc2", TOOL, { project: "OPS", summary: "Second" }, "m1");
    const second = "00000000-0000-4000-8000-000900000002";
    fake.requestApproval(runId, asked({ approval_id: second, tool_call_id: "tc2" }));
    await waitFor(() =>
      expect(screen.getAllByRole("group", { name: /Approval needed/ })).toHaveLength(2),
    );
    // The card that loads its options after the second request offers it.
    const cards = screen.getAllByRole("group", { name: /Approval needed/ });
    const last = must(cards[1]);
    await user.click(await within(last).findByRole("button", { name: "Approve all waiting (2)" }));
    const confirm = within(last).getByRole("group", { name: "Approve all waiting" });
    expect(confirm.textContent).toMatch(/Allow all 2 calls waiting in this run\?/);
    await user.click(within(confirm).getByRole("button", { name: "Allow all 2" }));
    await waitFor(() => expect(screen.getAllByText("Approved.")).toHaveLength(2));
    const all = fake.requests.find((r) => r.path === "/v1/approvals/approve-all");
    expect(all?.body).toEqual({ run_id: runId, approval_ids: [APPROVAL, second].sort() });
  });

  it("a call a remembered approval allowed says so on its tool card", async () => {
    const t = fake.addThread("Ops");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "file a ticket{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    fake.agent.toolCall(runId, "tc9", TOOL, { project: "OPS" }, "m1");
    fake.emit(runId, "policy.rule_applied", {
      tool_call_id: "tc9",
      tool: TOOL,
      rule_id: "00000000-0000-4000-8000-0000000000aa",
      scope: "today",
    });
    const note = await screen.findByText(/Allowed by your rule \(until end of today\)\./);
    expect(note.textContent).toMatch(/revoke it in My area, Approvals/);
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

  it("shows bidi overrides and zero-width characters as visible escapes (RLO payload)", () => {
    // Renders as "invoice_exe.txt" on screen if the U+202E is passed through.
    const path = "invoice_\u202etxt.exe\u200b";
    render(<ApprovalCard requested={asked({ input: { path } })} resolved={undefined} api={api} />);
    const shown = must(screen.getByLabelText("Input to approve").textContent);
    expect(shown).toContain("invoice_\\u202etxt.exe\\u200b");
    expect(shown).not.toMatch(/[\u202e\u200b]/);
  });

  it("flags and escapes a tool name with non-ASCII characters (homoglyphs)", () => {
    // Cyrillic "е" in "creatе_issue".
    render(
      <ApprovalCard
        requested={asked({ tool: "mcp__jira__creat\u0435_issue" })}
        resolved={undefined}
        api={api}
      />,
    );
    expect(screen.getByText(/contains non-ASCII characters/)).toBeTruthy();
    const title = must(screen.getByRole("group").textContent);
    expect(title).toContain("mcp__jira__creat\\u0435_issue");
    expect(title).not.toContain("\u0435");
  });

  it("never offers 'remember' for destructive tools, whatever the options say", async () => {
    const withOptions = {
      ...api,
      rememberOptions: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          data: {
            approvalId: APPROVAL,
            runId: "r",
            canRemember: true,
            reason: null,
            choices: [{ scope: "day" as const, label: "for 1 day", expiresAt: null }],
            timeZone: "UTC",
            exact: null,
            exactOnly: false,
            approveAll: null,
            approveAllReason: null,
          },
        }),
      ),
    };
    render(
      <ApprovalCard
        requested={asked({ risk: "destructive" })}
        resolved={undefined}
        api={withOptions}
      />,
    );
    await waitFor(() => expect(withOptions.rememberOptions).toHaveBeenCalled());
    expect(screen.queryByRole("checkbox", { name: /Remember/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

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

  describe("remember (KOBE-158)", () => {
    const input = {
      scope: "project",
      path: "topics/p\u202eq.md",
      mode: "append",
      content:
        "See [docs](https://evil.example/x) ![i](https://evil.example/p.png)\n<b>bold</b> a\u200bb\u202ec",
    };

    it("shows exactly what will be stored as plain text, hidden characters escaped", async () => {
      const t = fake.addThread("Notes");
      openApp(fake, t);
      const user = userEvent.setup();
      await user.type(await composer(), "remember{Enter}");
      await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
      const runId = must(fake.activeRun(t)).run_id;
      await streaming(fake, runId);
      fake.agent.toolCall(runId, "tc1", "remember", input, "m1");
      fake.requestApproval(runId, asked({ tool: "remember", input }));
      const card = await screen.findByRole("group", { name: /Approval needed/ });
      const stored = screen.getByLabelText("Memory to store");
      expect(stored.textContent).toContain(
        "[docs](https://evil.example/x) ![i](https://evil.example/p.png)\n<b>bold</b> a\\u200bb\\u202ec",
      );
      expect(card.textContent).toContain("project memory");
      expect(card.textContent).toContain("topics/p\\u202eq.md");
      expect(card.textContent).toContain("added to the end");
      expect(card.querySelector("a, img, b")).toBeNull();
    });
  });
});

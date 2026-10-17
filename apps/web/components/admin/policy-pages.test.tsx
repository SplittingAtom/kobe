// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { PolicyFloorPage } from "./site/policy-floor-page";
import { TeamPolicyPage } from "./team/policy-page";
import {
  forbidNativeConfirm,
  TEAM,
  answerConfirm,
  renderSite,
  renderTeam,
  stubApi,
  summary,
} from "./testing";

const rule = (
  id: string,
  effect: string,
  tool_glob: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  scope: "site",
  scope_ref: null,
  effect,
  tool_glob,
  arg_pattern: null,
  note: null,
  created_by: "u",
  created_at: "2026-10-01T10:00:00Z",
  expires_at: null,
  ...extra,
});

/** Remember limits as the server sends them (KOBE-289): everything allowed. */
const LIMITS = {
  scopes: ["thread", "today", "run", "day", "month", "forever"],
  max_duration_seconds: null,
  mcp_tools: true,
  exact_only: false,
  approve_all: true,
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Site policy floor", () => {
  const routes = {
    "GET /v1/site/policy/rules": [
      200,
      {
        rules: [
          rule("r-1", "deny", "mcp__github__*", {
            note: "No GitHub",
            arg_pattern: { "/repo_name": "secret-*" },
          }),
        ],
      },
    ],
    "GET /v1/site/policy/settings": [200, { promptSandboxWrites: false }],
    "GET /v1/site/policy/remember-limits": [200, { limits: LIMITS }],
  } as const;

  it("lists rules with their argument patterns and offers only deny and ask", async () => {
    stubApi(routes);
    renderSite(<PolicyFloorPage />);
    const table = await screen.findByRole("table", { name: /Site rules/ });
    expect(table.textContent).toMatch(/Deny.*mcp__github__\*/);
    expect(table.textContent).toMatch(/\/repo_name.*secret-\*/);
    expect(table.textContent).toMatch(/No GitHub/);
    const form = screen.getByRole("form", { name: "Add a rule" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Deny", "Ask"]);
  });

  it("adds a rule with the wire body and removes one", async () => {
    const calls = stubApi({
      ...routes,
      "POST /v1/site/policy/rules": [201, { rule: rule("r-2", "ask", "bash") }],
      "DELETE /v1/site/policy/rules/r-1": [204],
    });
    renderSite(<PolicyFloorPage />);
    const form = await screen.findByRole("form", { name: "Add a rule" });
    await userEvent.selectOptions(within(form).getByLabelText("Effect"), "ask");
    await userEvent.type(within(form).getByLabelText(/^Tool pattern/), "bash");
    await userEvent.type(within(form).getByLabelText("Note (optional)"), "Shell asks");
    await userEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    await screen.findByText("Added: Ask for bash.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      effect: "ask",
      tool_glob: "bash",
      note: "Shell asks",
      expires_at: null,
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove rule Deny mcp__github__*" }));
    await answerConfirm('Remove the rule "Deny mcp__github__*"?', "Remove rule");
    await screen.findByText("Removed: Deny for mcp__github__*.");
    expect(summary(calls)).toContain("DELETE /v1/site/policy/rules/r-1");
  });

  it("shows the server's validation and limit errors", async () => {
    stubApi({
      ...routes,
      "POST /v1/site/policy/rules": [
        409,
        {
          code: "too_many_rules",
          message: "This scope has reached its rule limit. Remove one first.",
        },
      ],
    });
    renderSite(<PolicyFloorPage />);
    const form = await screen.findByRole("form", { name: "Add a rule" });
    await userEvent.type(within(form).getByLabelText(/^Tool pattern/), "x");
    await userEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/rule limit/);
  });

  it("saves the sandbox-writes switch", async () => {
    const calls = stubApi({
      ...routes,
      "PUT /v1/site/policy/settings": [200, { promptSandboxWrites: true }],
    });
    renderSite(<PolicyFloorPage />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Ask before shell and file writes/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save setting" }));
    await screen.findByText(/now ask/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ promptSandboxWrites: true });
  });

  it("renders a 403", async () => {
    stubApi({
      "GET /v1/site/policy/rules": [
        403,
        { code: "forbidden", message: "You don't have permission to do that." },
      ],
      "GET /v1/site/policy/settings": [
        403,
        { code: "forbidden", message: "You don't have permission to do that." },
      ],
      "GET /v1/site/policy/remember-limits": [
        403,
        { code: "forbidden", message: "You don't have permission to do that." },
      ],
    });
    renderSite(<PolicyFloorPage />);
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toMatch(/permission/);
  });
});

const TEAM_REMEMBER = {
  "GET /v1/team/policy/member-rules": [200, { rules: [] }],
  "GET /v1/team/policy/remember-limits": [200, { site: LIMITS, team: LIMITS, effective: LIMITS }],
} as const;

describe("Team policy", () => {
  it("offers deny, ask and allow, names the team, and shows the server's allow-scope refusal", async () => {
    const calls = stubApi({
      "GET /v1/team/policy/rules": [
        200,
        { rules: [rule("r-1", "allow", "read", { scope: "team" })] },
      ],
      "POST /v1/team/policy/rules": [
        400,
        {
          code: "invalid_request",
          message:
            "Check tool_glob: an allow rule must name one built-in tool or one connector's tools (mcp__<server>__…).",
        },
      ],
      ...TEAM_REMEMBER,
    });
    renderTeam(<TeamPolicyPage />);
    const form = await screen.findByRole("form", { name: "Add a rule" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Deny", "Ask", "Allow"]);
    await userEvent.selectOptions(within(form).getByLabelText("Effect"), "allow");
    await userEvent.type(within(form).getByLabelText(/^Tool pattern/), "*");
    await userEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/allow rule must name one/);
    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
    expect(screen.getByRole("table", { name: /Team rules/ }).textContent).toMatch(/Allow.*read/);
  });
});

describe("Members' remembered approvals and remember limits (KOBE-289)", () => {
  const memberRule = {
    id: "mr-1",
    user_id: "u-bob",
    user_name: "Bob",
    tool_glob: "mcp__jira__create_issue",
    arg_pattern: { "/project": "OPS" },
    remember_scope: "day",
    thread_id: null,
    thread_title: null,
    run_id: null,
    created_at: "2026-10-16T10:00:00Z",
    expires_at: "2026-10-17T10:00:00Z",
    last_used_at: null,
  };

  it("team admins see members' rules and revoke them in their team", async () => {
    const calls = stubApi({
      "GET /v1/team/policy/rules": [200, { rules: [] }],
      ...TEAM_REMEMBER,
      "GET /v1/team/policy/member-rules": [200, { rules: [memberRule] }],
      "DELETE /v1/team/policy/member-rules/mr-1": [204],
    });
    renderTeam(<TeamPolicyPage />);
    const table = await screen.findByRole("table", { name: /Remembered approvals \(1\)/ });
    expect(table.textContent).toMatch(
      /Bob.*mcp__jira__create_issue.*for 1 day.*\/project is exactly OPS/,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Bob's rule for mcp__jira__create_issue" }),
    );
    await answerConfirm(/of Bob for mcp__jira__create_issue/, "Revoke");
    await screen.findByText(/Revoked: mcp__jira__create_issue/);
    const del = must(calls.find((c) => c.method === "DELETE"));
    expect(del.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("team limits: what the site floor forbids can't be picked, and the save is clamped to it", async () => {
    const floor = {
      ...LIMITS,
      scopes: ["thread", "run", "day"],
      max_duration_seconds: 86400,
      approve_all: false,
    };
    const calls = stubApi({
      "GET /v1/team/policy/rules": [200, { rules: [] }],
      "GET /v1/team/policy/member-rules": [200, { rules: [] }],
      "GET /v1/team/policy/remember-limits": [200, { site: floor, team: LIMITS, effective: floor }],
      "PUT /v1/team/policy/remember-limits": [200, { site: floor, team: floor, effective: floor }],
    });
    renderTeam(<TeamPolicyPage />);
    const form = await screen.findByRole("form", { name: "Team remember limits" });
    const box = (name: RegExp) => within(form).getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box(/^Until revoked/).disabled).toBe(true);
    expect(box(/^Until end of today/).disabled).toBe(true);
    expect(box(/^This conversation/).checked).toBe(true);
    expect(box(/Approve all waiting/).disabled).toBe(true);
    const longest = within(form).getByLabelText(
      /Longest a remembered approval/,
    ) as HTMLSelectElement;
    const disabled = [...longest.options].filter((o) => o.disabled).map((o) => o.textContent);
    expect(disabled).toEqual(["No limit", "7 days", "30 days", "90 days"]);
    await userEvent.click(box(/^This run only/));
    await userEvent.click(box(/connector \(MCP\) tools/));
    await userEvent.click(within(form).getByRole("button", { name: "Save limits" }));
    await screen.findByText(/Approval cards offer only these choices/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      scopes: ["thread", "day"],
      max_duration_seconds: 86400,
      mcp_tools: false,
      exact_only: false,
      approve_all: false,
    });
  });

  it("the site floor saves its limits", async () => {
    const calls = stubApi({
      "GET /v1/site/policy/rules": [200, { rules: [] }],
      "GET /v1/site/policy/settings": [200, { promptSandboxWrites: false }],
      "GET /v1/site/policy/remember-limits": [200, { limits: LIMITS }],
      "PUT /v1/site/policy/remember-limits": [200, { limits: { ...LIMITS, exact_only: true } }],
    });
    renderSite(<PolicyFloorPage />);
    const form = await screen.findByRole("form", { name: "Site remember limits" });
    await userEvent.click(within(form).getByRole("checkbox", { name: /only exact actions/ }));
    await userEvent.selectOptions(within(form).getByLabelText(/Longest/), "8 hours");
    await userEvent.click(within(form).getByRole("button", { name: "Save limits" }));
    await screen.findByText(/Approval cards offer only these choices/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      ...LIMITS,
      exact_only: true,
      max_duration_seconds: 28800,
    });
  });
});

// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { PolicyFloorPage } from "./install/policy-floor-page";
import { TeamPolicyPage } from "./team/policy-page";
import { TEAM, renderInstall, renderTeam, stubApi, summary } from "./testing";

const rule = (
  id: string,
  effect: string,
  tool_glob: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  scope: "install",
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

beforeEach(() =>
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Install policy floor", () => {
  const routes = {
    "GET /v1/install/policy/rules": [
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
    "GET /v1/install/policy/settings": [200, { promptSandboxWrites: false }],
  } as const;

  it("lists rules with their argument patterns and offers only deny and ask", async () => {
    stubApi(routes);
    renderInstall(<PolicyFloorPage />);
    const table = await screen.findByRole("table", { name: /Install rules/ });
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
      "POST /v1/install/policy/rules": [201, { rule: rule("r-2", "ask", "bash") }],
      "DELETE /v1/install/policy/rules/r-1": [204],
    });
    renderInstall(<PolicyFloorPage />);
    const form = await screen.findByRole("form", { name: "Add a rule" });
    await userEvent.selectOptions(within(form).getByLabelText("Effect"), "ask");
    await userEvent.type(within(form).getByLabelText("Tool pattern"), "bash");
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
    await screen.findByText("Removed: Deny for mcp__github__*.");
    expect(summary(calls)).toContain("DELETE /v1/install/policy/rules/r-1");
  });

  it("shows the server's validation and limit errors", async () => {
    stubApi({
      ...routes,
      "POST /v1/install/policy/rules": [
        409,
        {
          code: "too_many_rules",
          message: "This scope has reached its rule limit. Remove one first.",
        },
      ],
    });
    renderInstall(<PolicyFloorPage />);
    const form = await screen.findByRole("form", { name: "Add a rule" });
    await userEvent.type(within(form).getByLabelText("Tool pattern"), "x");
    await userEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/rule limit/);
  });

  it("saves the sandbox-writes switch", async () => {
    const calls = stubApi({
      ...routes,
      "PUT /v1/install/policy/settings": [200, { promptSandboxWrites: true }],
    });
    renderInstall(<PolicyFloorPage />);
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
      "GET /v1/install/policy/rules": [
        403,
        { code: "forbidden", message: "You don't have permission to do that." },
      ],
      "GET /v1/install/policy/settings": [
        403,
        { code: "forbidden", message: "You don't have permission to do that." },
      ],
    });
    renderInstall(<PolicyFloorPage />);
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toMatch(/permission/);
  });
});

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
    });
    renderTeam(<TeamPolicyPage />);
    const form = await screen.findByRole("form", { name: "Add a rule" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Deny", "Ask", "Allow"]);
    await userEvent.selectOptions(within(form).getByLabelText("Effect"), "allow");
    await userEvent.type(within(form).getByLabelText("Tool pattern"), "*");
    await userEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/allow rule must name one/);
    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
    expect(screen.getByRole("table", { name: /Team rules/ }).textContent).toMatch(/Allow.*read/);
  });
});

// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi, TEAM } from "../admin/testing";
import { MyApprovalsPage } from "./my-approvals-page";

const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const THREAD = "00000000-0000-4000-8000-00000000d001";

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: "u-me",
  user_name: "Me",
  tool_glob: "share_file",
  arg_pattern: null,
  remember_scope: "forever",
  thread_id: null,
  thread_title: null,
  run_id: null,
  created_at: "2026-10-16T10:00:00Z",
  expires_at: null,
  last_used_at: null,
  masked: false,
  applies: true,
  ended_reason: null,
  ...over,
  arg_pointers: Object.keys((over.arg_pattern as Record<string, string> | null) ?? {}),
});

const routes = {
  "GET /v1/team/policy/my-rules": [
    200,
    {
      rules: [
        rule("r-1", {
          remember_scope: "thread",
          thread_id: THREAD,
          thread_title: "Q3 <b>report</b>",
          last_used_at: "2026-10-17T09:00:00Z",
        }),
        rule("r-2", {
          tool_glob: "write",
          remember_scope: "today",
          arg_pattern: { "/path": "/workspace/q3\\*.md" },
          expires_at: "2026-10-17T22:00:00Z",
        }),
      ],
    },
  ],
  "GET /v1/me/time-zone": [200, { time_zone: "Europe/Berlin" }],
} as const;

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("My area, Approvals (KOBE-289 ac-4)", () => {
  it("lists remembered approvals: tool, scope, exact action, expiry and last use", async () => {
    stubApi(routes);
    const { container } = renderTeam(<MyApprovalsPage />, MEMBER);
    const table = await screen.findByRole("table", { name: /Your remembered approvals \(2\)/ });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]?.textContent).toMatch(
      /share_file.*this conversation: Q3 <b>report<\/b>.*Any input/,
    );
    expect(container.querySelector("b")).toBeNull();
    const link = within(must(rows[1])).getByRole("link", { name: "Q3 <b>report</b>" });
    expect(link.getAttribute("href")).toBe(`/?thread=${THREAD}`);
    expect(rows[1]?.textContent).toMatch(/With the conversation/);
    // The exact pattern is shown as the literal text it matches.
    expect(rows[2]?.textContent).toMatch(
      /write.*until end of today.*\/path is exactly \/workspace\/q3\*\.md/,
    );
    expect(rows[2]?.textContent).toMatch(/Not yet/);
  });

  it("shows a rule the server ignores as no longer applying, with the reason, and only Remove", async () => {
    const calls = stubApi({
      "GET /v1/team/policy/my-rules": [
        200,
        {
          rules: [
            rule("r-9", {
              tool_glob: "bash",
              applies: false,
              ended_reason: "This tool can delete data, so approvals of it are never remembered.",
            }),
          ],
        },
      ],
      "GET /v1/me/time-zone": [200, { time_zone: null }],
      "DELETE /v1/team/policy/my-rules/r-9": [204],
    });
    renderTeam(<MyApprovalsPage />, MEMBER);
    const table = await screen.findByRole("table", { name: /Your remembered approvals/ });
    expect(table.textContent).toMatch(/No longer applies.*never remembered/);
    expect(within(table).queryByRole("button", { name: /^Revoke/ })).toBeNull();
    await userEvent.click(within(table).getByRole("button", { name: "Remove rule for bash" }));
    await answerConfirm(/Remove the remembered approval for bash/, "Remove");
    await screen.findByText("Removed: bash (until revoked).");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("revokes one after confirming, in the active team", async () => {
    const calls = stubApi({
      ...routes,
      "DELETE /v1/team/policy/my-rules/r-1": [204],
    });
    renderTeam(<MyApprovalsPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke rule for share_file" }),
    );
    const text = await answerConfirm(/Revoke the remembered approval for share_file/, "Revoke");
    expect(text).toMatch(/asks again/);
    await screen.findByText("Revoked: share_file (this conversation).");
    const del = must(calls.find((c) => c.method === "DELETE"));
    expect(del.url).toBe("/v1/team/policy/my-rules/r-1");
    expect(del.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("shows an empty list and saves the time zone", async () => {
    const calls = stubApi({
      "GET /v1/team/policy/my-rules": [200, { rules: [] }],
      "GET /v1/me/time-zone": [200, { time_zone: null }],
      "PUT /v1/me/time-zone": [200, { time_zone: "America/New_York" }],
    });
    renderTeam(<MyApprovalsPage />, MEMBER);
    expect(await screen.findByText(/Nothing remembered/)).toBeTruthy();
    const input = await screen.findByLabelText("Your time zone");
    await userEvent.clear(input);
    await userEvent.type(input, "America/New_York");
    await userEvent.click(screen.getByRole("button", { name: "Save time zone" }));
    await screen.findByText("Saved: America/New_York.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ time_zone: "America/New_York" });
  });
});

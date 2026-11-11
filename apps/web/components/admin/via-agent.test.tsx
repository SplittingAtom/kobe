// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { SiteAuditPage } from "./site/audit-page";
import { TeamAuditPage } from "./team/audit-page";
import { forbidNativeConfirm, ME, renderSite, renderTeam, stubApi, TEAM } from "./testing";

/** Audit rows written through a Kobe MCP admin tool say "via agent" (KOBE-623, spec §7). */

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const THREAD = "00000000-0000-4000-8000-0000000000c1";
const RUN = "00000000-0000-4000-8000-0000000000c2";

const changed = (threadOpen: boolean, id = "ev-1") => ({
  id,
  seq: 9,
  at: "2026-11-11T10:05:00Z",
  team_id: TEAM.id,
  actor: { kind: "user", id: "u-ana", name: "Ana Lee", email: "ana@x.io" },
  action: "identity.member.role_changed",
  target: {
    userId: "u-bob",
    from: "member",
    to: "team_admin",
    viaAgent: { threadId: THREAD, runId: RUN, toolCallId: "tc-1" },
  },
  via_agent: { thread_id: THREAD, run_id: RUN, tool_call_id: "tc-1", thread_open: threadOpen },
  ip: null,
  user_agent: null,
});

describe("audit views: via agent", () => {
  it("team view: the person via agent, with the thread link when the server allows it", async () => {
    stubApi({
      "GET /v1/team/break-glass": [200, { active: [], recent: [] }],
      "GET /v1/team/audit?limit=50": [
        200,
        {
          events: [
            changed(true),
            changed(false, "ev-2"),
            { ...changed(true, "ev-3"), via_agent: undefined },
          ],
          next_cursor: null,
        },
      ],
    });
    renderTeam(<TeamAuditPage />);
    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    const first = within(must(rows[1]));
    expect(first.getByText(/via agent/)).toBeTruthy();
    expect(first.getByRole("link", { name: "open the thread" }).getAttribute("href")).toBe(
      `/?thread=${THREAD}`,
    );
    expect(must(rows[1]).textContent).toContain(`run ${RUN}, tool call tc-1`);
    const second = within(must(rows[2]));
    expect(second.getByText(/via agent/)).toBeTruthy();
    expect(second.queryByRole("link")).toBeNull();
    expect(within(must(rows[3])).queryByText(/via agent/)).toBeNull();
  });

  it("site view: the same note under the person", async () => {
    stubApi({
      "GET /v1/site/users": [200, { users: [{ ...ME, siteRole: "admin" }] }],
      "GET /v1/site/teams": [200, { teams: [] }],
      "GET /v1/site/settings": [200, { requireTwoFactor: false, auditPiiRetentionHours: 12 }],
      "GET /v1/site/audit?limit=50": [200, { events: [changed(false)], next_cursor: null }],
    });
    renderSite(<SiteAuditPage />);
    const table = await screen.findByRole("table", { name: "Audit events, newest first" });
    const row = must(within(table).getAllByRole("row")[1]);
    expect(row.textContent).toMatch(/Ana Lee.*via agent.*run .*tool call tc-1/);
    expect(within(row).queryByRole("link")).toBeNull();
  });
});

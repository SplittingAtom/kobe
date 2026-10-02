// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { BreakGlassPage } from "./install/break-glass-page";
import { entryText } from "./install/break-glass-reader";
import { TeamBreakGlassPage } from "./team/break-glass-page";
import { ME, TEAM, renderInstall, renderTeam, stubApi, summary } from "./testing";

const TEAMS = { teams: [{ id: "t-1", slug: "fin", name: "Finance" }] };
const ROSTER = {
  members: [{ userId: "u-bob", name: "Bob", email: "b@x.io", role: "member", joined_at: "" }],
};

// Server answers in camelCase for grants; reads mirror the thread API's snake_case.
const grant = (over: Record<string, unknown> = {}) => ({
  id: "g-1",
  team: { id: "t-1", slug: "fin", name: "Finance" },
  requestedBy: { id: "u-inv", name: "Ivy", email: "i@x.io" },
  approvedBy: null,
  decidedBy: null,
  scope: "team",
  subject: null,
  threadId: null,
  reason: "Incident 42",
  legalHold: false,
  durationMinutes: 60,
  status: "pending",
  selfApproved: false,
  requestedAt: "2026-10-02T10:00:00Z",
  requestExpiresAt: "2026-10-03T10:00:00Z",
  decidedAt: null,
  startsAt: null,
  expiresAt: null,
  endedAt: null,
  actions: { approve: true, deny: true, revoke: true, read: false },
  ...over,
});

const ACTIVE_OWN = grant({
  id: "g-2",
  requestedBy: { id: ME.id, name: ME.name, email: ME.email },
  approvedBy: { id: "u-owner", name: "Olive", email: "o@x.io" },
  status: "active",
  startsAt: "2026-10-02T10:00:00Z",
  expiresAt: "2026-10-02T11:00:00Z",
  actions: { approve: false, deny: false, revoke: true, read: true },
});

beforeEach(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("install break-glass page", () => {
  it("requests access narrowed to one user, with reason, duration and legal hold", async () => {
    const calls = stubApi({
      "GET /v1/install/break-glass": [200, { grants: [], selfApprovalAllowed: false }],
      "GET /v1/install/teams": [200, TEAMS],
      "GET /v1/install/teams/t-1/members": [200, ROSTER],
      "POST /v1/install/break-glass": [201, { grant: grant({ scope: "user" }) }],
    });
    renderInstall(<BreakGlassPage />);
    const form = await screen.findByRole("form", { name: "Request break-glass access" });
    await userEvent.selectOptions(within(form).getByLabelText("Team"), "t-1");
    await userEvent.click(within(form).getByLabelText("One user's threads"));
    await screen.findByRole("option", { name: /Bob/ });
    await userEvent.selectOptions(within(form).getByLabelText("User"), "u-bob");
    await userEvent.selectOptions(within(form).getByLabelText("Duration"), "120");
    await userEvent.type(within(form).getByLabelText("Reason"), "Incident 42: exfiltration");
    await userEvent.click(within(form).getByLabelText(/Legal hold/));
    await userEvent.click(within(form).getByRole("button", { name: "Request access" }));
    await screen.findByText(/A second install admin must approve it/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      teamId: "t-1",
      reason: "Incident 42: exfiltration",
      durationMinutes: 120,
      legalHold: true,
      userId: "u-bob",
    });
    expect(post.headers.get("x-kobe-team")).toBeNull();
  });

  it("offers approve and deny on others' requests, and shows the server's refusal", async () => {
    const calls = stubApi({
      "GET /v1/install/break-glass": [200, { grants: [grant()], selfApprovalAllowed: false }],
      "GET /v1/install/teams": [200, TEAMS],
      "POST /v1/install/break-glass/g-1/approve": [
        403,
        {
          code: "self_approval_forbidden",
          message: "A second install admin must approve your request.",
        },
      ],
    });
    renderInstall(<BreakGlassPage />);
    const row = (await screen.findByText("Incident 42")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Waiting for approval")).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A second install admin must approve",
    );
    expect(summary(calls)).toContain("POST /v1/install/break-glass/g-1/approve");
  });

  it("explains self-approval on a single-admin install and shows the flag", async () => {
    stubApi({
      "GET /v1/install/break-glass": [
        200,
        {
          grants: [
            grant({
              status: "active",
              selfApproved: true,
              approvedBy: { id: "u-inv", name: "Ivy", email: "i@x.io" },
              startsAt: "2026-10-02T10:00:00Z",
              expiresAt: "2026-10-02T11:00:00Z",
              actions: { approve: false, deny: false, revoke: true, read: false },
            }),
          ],
          selfApprovalAllowed: true,
        },
      ],
      "GET /v1/install/teams": [200, TEAMS],
    });
    renderInstall(<BreakGlassPage />);
    await screen.findByText(/only active admin/);
    expect(screen.getByText(/Self-approved by Ivy \(flagged\)/)).toBeTruthy();
  });

  it("reads threads and entries read-only under an own active grant", async () => {
    const calls = stubApi({
      "GET /v1/install/break-glass": [200, { grants: [ACTIVE_OWN], selfApprovalAllowed: false }],
      "GET /v1/install/teams": [200, TEAMS],
      "GET /v1/install/break-glass/g-2/threads": [
        200,
        {
          grant: {
            id: "g-2",
            team_id: "t-1",
            scope: "team",
            user_id: null,
            thread_id: null,
            expires_at: "",
          },
          threads: [
            {
              thread_id: "th-1",
              title: "Plans",
              status: "idle",
              owner_user_id: "u-bob",
              last_activity_at: "2026-10-02T09:00:00Z",
              created_at: "2026-10-02T09:00:00Z",
              deleted_at: null,
            },
          ],
          next_cursor: null,
        },
      ],
      "GET /v1/install/break-glass/g-2/threads/th-1/entries?after=0": [
        200,
        {
          grant: { id: "g-2" },
          entries: [
            {
              entry_id: "e1",
              parent_id: null,
              seq: 1,
              type: "message",
              payload: { message: { role: "user", content: "the secret", tool_call_id: "x" } },
              payload_offloaded: false,
              created_at: "2026-10-02T09:00:00Z",
            },
          ],
          next_after: null,
        },
      ],
    });
    renderInstall(<BreakGlassPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Read" }));
    expect(await screen.findByRole("note")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    await screen.findByText("the secret");
    expect(
      summary(calls).filter(
        (c) => c.startsWith("POST") || c.startsWith("PATCH") || c.startsWith("DELETE"),
      ),
    ).toEqual([]);
  });

  it("shows a revoked or expired grant's refusal on the next read", async () => {
    stubApi({
      "GET /v1/install/break-glass": [200, { grants: [ACTIVE_OWN], selfApprovalAllowed: false }],
      "GET /v1/install/teams": [200, TEAMS],
      "GET /v1/install/break-glass/g-2/threads": [
        403,
        {
          code: "grant_not_active",
          message: "This grant doesn't give access now.",
          status: "revoked",
        },
      ],
    });
    renderInstall(<BreakGlassPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Read" }));
    expect((await screen.findByRole("alert")).textContent).toContain("doesn't give access now");
  });
});

describe("entryText", () => {
  it("shows message text, text parts, or the entry as JSON", () => {
    const base = {
      entryId: "e",
      parentId: null,
      seq: 1,
      type: "message",
      createdAt: "",
      payloadOffloaded: false,
    };
    expect(entryText({ ...base, payload: { message: { content: "hi" } } })).toBe("hi");
    expect(
      entryText({
        ...base,
        payload: { message: { content: [{ type: "text", text: "a" }, { type: "image" }] } },
      }),
    ).toBe("a");
    expect(entryText({ ...base, payload: { other: 1 } })).toContain('"other": 1');
    expect(entryText({ ...base, payload: {}, payloadOffloaded: true })).toContain("object storage");
  });
});

describe("team break-glass page", () => {
  it("shows a banner per active grant (legal hold restricted) and the history, for its team", async () => {
    const calls = stubApi({
      "GET /v1/team/break-glass": [
        200,
        {
          active: [
            {
              id: "g-1",
              status: "active",
              requested_by: { id: "u-inv", name: "Ivy" },
              approved_by: { id: "u-owner", name: "Olive" },
              self_approved: false,
              legal_hold: true,
              scope: "restricted",
              subject: null,
              thread_id: null,
              reason: null,
              starts_at: "2026-10-02T10:00:00Z",
              expires_at: "2026-10-02T11:00:00Z",
              ended_at: null,
            },
          ],
          recent: [
            {
              id: "g-0",
              status: "revoked",
              requestedBy: { id: "u-inv", name: "Ivy" },
              approvedBy: { id: "u-owner", name: "Olive" },
              selfApproved: false,
              legalHold: false,
              scope: "user",
              subject: { id: "u-bob", name: "Bob" },
              threadId: null,
              reason: "Incident 7",
              startsAt: "2026-10-01T10:00:00Z",
              expiresAt: "2026-10-01T11:00:00Z",
              endedAt: "2026-10-01T10:30:00Z",
            },
          ],
        },
      ],
    });
    renderTeam(<TeamBreakGlassPage />);
    const banner = await screen.findByRole("note", { name: "Active break-glass access" });
    expect(banner.textContent).toContain("Ivy");
    expect(banner.textContent).toContain("Restricted (legal hold)");
    expect(screen.getByText("Threads of Bob")).toBeTruthy();
    expect(screen.getByText("Incident 7")).toBeTruthy();
    await waitFor(() => expect(calls[0]?.headers.get("x-kobe-team")).toBe(TEAM.id));
  });

  it("says when nobody has access", async () => {
    stubApi({ "GET /v1/team/break-glass": [200, { active: [], recent: [] }] });
    renderTeam(<TeamBreakGlassPage />);
    await screen.findByText(/No install admin has break-glass access/);
  });
});

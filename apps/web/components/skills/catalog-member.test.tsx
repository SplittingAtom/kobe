// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, renderTeam, stubApi, summary } from "../admin/testing";
import { MemberAddsSection } from "../admin/team/skill-editor/member-adds-section";
import { CatalogDetailPage } from "./catalog-detail-page";

/** KOBE-338 (SK25, U31): Add for me, Request for team, blocks; the console's lists. */
const MEMBER = { role: "member", permissions: ["team.read"] } as const;
const ADMIN = {
  role: "team_admin",
  permissions: ["team.read", "team.skills.publish", "team.skills.installs.manage"],
} as const;

const version = (id: string, semver: string, state: string) => ({
  id,
  semver,
  state,
  approved_at: null,
  changelog: null,
  verdict: "pass",
});

const detail = (over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
  id: "id-sales",
  name: "sales-report",
  summary: "Sales.",
  publisher: "maintainer",
  status: "active",
  topics: [],
  latest: { version_id: "v2", semver: "1.1.0", verdict: "pass", approved_at: null },
  score: null,
  teams_installed: "few",
  state: { installed: null, added_by_me: false, my_add: null, blocked: false, ...state },
  skill_md: null,
  files: [],
  versions: [
    version("v2", "1.1.0", "approved"),
    version("v1", "1.0.0", "deprecated"),
    version("v0", "0.9.0", "revoked"),
  ],
  authoritative_scorecard: null,
  license: null,
  egress: [],
  packages: {},
  maintainers: [],
  agents: [],
  can_request_egress: true,
  members_may_add: true,
  can_block: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Add for me and Request for team on the catalog detail", () => {
  it("adds at an approved version and pin, and asks the Team admins to install it", async () => {
    const calls = stubApi({
      "GET /v1/skills/catalog/id-sales": [200, detail()],
      "PUT /v1/me/skills/adds/id-sales": [
        200,
        { semver: "1.1.0", pin_mode: "pinned", runs: "1.1.0" },
      ],
      "POST /v1/skills/catalog/id-sales/request": [
        202,
        { requested: true, already_requested: false },
      ],
    });
    renderTeam(<CatalogDetailPage skillId="id-sales" />, MEMBER);
    const form = await screen.findByRole("form", { name: "Add for me" });
    // Only approved versions: deprecated and revoked ones are not a member's to add.
    expect(Array.from(form.querySelectorAll("option")).map((o) => o.value)).not.toContain("1.0.0");
    expect(Array.from(form.querySelectorAll("option")).map((o) => o.value)).not.toContain("0.9.0");
    // A member can't install for the team.
    expect(screen.queryByRole("form", { name: "Install in this team" })).toBeNull();
    await userEvent.selectOptions(within(form).getByLabelText("Pin"), "pinned");
    await userEvent.click(within(form).getByRole("button", { name: "Add for me" }));
    expect(
      await screen.findByText("Added sales-report for you: your runs here load 1.1.0."),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ version: "1.1.0", pinMode: "pinned" });

    await userEvent.click(screen.getByRole("button", { name: "Request for team" }));
    expect(
      await screen.findByText("Asked your Team admins to install sales-report for the team."),
    ).toBeTruthy();
  });

  it("shows the member's add with Remove, and no Request once the team installed it", async () => {
    const calls = stubApi({
      "GET /v1/skills/catalog/id-sales": [
        200,
        detail(
          {},
          {
            installed: { semver: "1.1.0", pin_mode: "pinned", access: "available" },
            added_by_me: true,
            my_add: { semver: "1.0.0", pin_mode: "within_major" },
          },
        ),
      ],
      "DELETE /v1/me/skills/adds/id-sales": [200, { removed: true }],
    });
    renderTeam(<CatalogDetailPage skillId="id-sales" />, MEMBER);
    expect(
      await screen.findByText("You added 1.0.0 (Track within major) for your own runs here."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request for team" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove my add" }));
    await waitFor(() => expect(summary(calls)).toContain("DELETE /v1/me/skills/adds/id-sales"));
  });

  it("hides Add for me while the team switch is off", async () => {
    stubApi({ "GET /v1/skills/catalog/id-sales": [200, detail({ members_may_add: false })] });
    renderTeam(<CatalogDetailPage skillId="id-sales" />, MEMBER);
    expect(
      await screen.findByText("This team doesn't let members add catalog skills for themselves."),
    ).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add for me" })).toBeNull();
    expect(screen.getByRole("button", { name: "Request for team" })).toBeTruthy();
  });

  it("a blocked skill offers neither; a Team admin unblocks it", async () => {
    const calls = stubApi({
      "GET /v1/skills/catalog/id-sales": [200, detail({ can_block: true }, { blocked: true })],
      "DELETE /v1/team/skills/blocks/id-sales": [200, { blocked: false }],
    });
    renderTeam(<CatalogDetailPage skillId="id-sales" />, ADMIN);
    expect(await screen.findByRole("button", { name: "Unblock in this team" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add for me" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request for team" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unblock in this team" }));
    await waitFor(() => expect(summary(calls)).toContain("DELETE /v1/team/skills/blocks/id-sales"));
  });

  it("a Team admin blocks a skill the team hasn't installed, after confirming", async () => {
    const calls = stubApi({
      "GET /v1/skills/catalog/id-sales": [200, detail({ can_block: true })],
      "PUT /v1/team/skills/blocks/id-sales": [
        200,
        { blocked: true, changed: true, adds_removed: 2 },
      ],
    });
    renderTeam(<CatalogDetailPage skillId="id-sales" />, ADMIN);
    fireEvent.click(await screen.findByRole("button", { name: "Block in this team" }));
    await answerConfirm(/Block sales-report/, "Block");
    expect(
      await screen.findByText("Blocked sales-report in this team; removed 2 member adds."),
    ).toBeTruthy();
    expect(summary(calls)).toContain("PUT /v1/team/skills/blocks/id-sales");
  });
});

describe("Member adds, blocks and requests in the team console", () => {
  it("lists them; Unblock and Dismiss", async () => {
    const calls = stubApi({
      "GET /v1/team/skills/member-adds": [
        200,
        {
          adds: [
            {
              user_id: "u1",
              member_name: "Mia",
              skill_id: "s1",
              name: "sales-report",
              semver: "1.0.0",
              pin_mode: "within_major",
              runs: "1.1.0",
              updated_at: "2026-10-18T10:00:00.000Z",
            },
          ],
        },
      ],
      "GET /v1/team/skills/blocks": [
        200,
        {
          blocks: [
            {
              skill_id: "s2",
              name: "slide-maker",
              blocked_by: "u2",
              blocked_by_name: "Ana",
              at: "2026-10-18T10:00:00.000Z",
            },
          ],
        },
      ],
      "GET /v1/team/skills/install-requests": [
        200,
        {
          requests: [
            {
              skill_id: "s3",
              name: "pdf-kit",
              requesters: [{ user_id: "u1", name: "Mia" }],
              count: 1,
              last_at: "2026-10-18T10:00:00.000Z",
            },
          ],
        },
      ],
      "DELETE /v1/team/skills/blocks/s2": [200, { blocked: false }],
      "POST /v1/team/skills/install-requests/s3/dismiss": [200, { dismissed: true }],
    });
    renderTeam(<MemberAddsSection />, ADMIN);
    const adds = await screen.findByRole("table", { name: "Member adds" });
    expect(within(adds).getByText("Mia")).toBeTruthy();
    expect(within(adds).getByText(/runs 1\.1\.0/)).toBeTruthy();
    const blocks = screen.getByRole("table", { name: "Blocked catalog skills" });
    expect(within(blocks).getByText("Ana")).toBeTruthy();
    const requests = screen.getByRole("table", { name: "Requested by members" });
    expect(within(requests).getByRole("link", { name: "pdf-kit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unblock slide-maker" }));
    await waitFor(() => expect(summary(calls)).toContain("DELETE /v1/team/skills/blocks/s2"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss requests for pdf-kit" }));
    await waitFor(() =>
      expect(summary(calls)).toContain("POST /v1/team/skills/install-requests/s3/dismiss"),
    );
  });
});

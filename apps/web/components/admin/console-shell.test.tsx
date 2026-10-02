// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { ConsoleAccess, InstallAccess, TeamAccess } from "../../lib/admin/nav/types";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";
import { must } from "../../lib/testing/must";
import { ConsoleShell } from "./console-shell";
import { ISOLATION_EVENT } from "./isolation-banner";

const user = { id: "u-1", name: "Ada", email: "a@x.io" };
const ok = <T,>(data: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, status: 200, data });
const fail = (status: number, code: string, message: string): Promise<ApiResult<ConsoleAccess>> =>
  Promise.resolve({ ok: false, error: { status, code, message } });
const install = (installRole: InstallAccess["installRole"]) => () =>
  ok<ConsoleAccess>({ console: "install", user, installRole });
const TEAM_ADMIN = [
  "team.members.manage",
  "team.agents.suspend",
  "team.models.manage",
  "team.budgets.manage",
  "team.connectors.manage",
  "team.egress.manage",
  "team.policy.manage",
  "team.skills.review",
  "team.retention.manage",
];
const team = (role: TeamAccess["role"], permissions: string[]) => () =>
  ok<ConsoleAccess>({
    console: "team",
    user,
    team: { id: "t-1", slug: "fin", name: "Finance" },
    role,
    permissions,
  });

function stubFetch(isolation: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body =
        url === "/v1/me/teams"
          ? {
              activeTeamId: "t-1",
              teams: [{ id: "t-1", slug: "fin", name: "Finance", role: "team_admin" }],
            }
          : isolation;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const pageMounted = vi.fn();
function Page() {
  pageMounted();
  return <h1>The page</h1>;
}

beforeEach(() => {
  pageMounted.mockClear();
  // The install shell's isolation banner asks for the status (verified unless a test says
  // otherwise); the team console's switcher asks for the caller's teams.
  stubFetch({ state: "verified", agentsEnabled: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("install console", () => {
  it.each(["owner", "admin"] as const)("opens for the %s with grouped navigation", async (role) => {
    render(
      <ConsoleShell kind="install" pathname="/admin/install/users" loadAccess={install(role)}>
        <Page />
      </ConsoleShell>,
    );
    expect(await screen.findByRole("heading", { name: "The page" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Install console sections" });
    const current = within(nav).getByRole("link", { name: "Users" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.getAttribute("href")).toBe("/admin/install/users");
    expect(
      within(nav).getByRole("link", { name: /Models and providers.*coming in KOBE-44/ }),
    ).toBeTruthy();
    expect(within(nav).getByRole("list", { name: "People" })).toBeTruthy();
  });

  it("refuses a plain user and never mounts the page", async () => {
    render(
      <ConsoleShell kind="install" pathname="/admin/install/users" loadAccess={install("user")}>
        <Page />
      </ConsoleShell>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/Owner and Admins/);
    expect(screen.queryByRole("navigation", { name: /sections/ })).toBeNull();
    expect(pageMounted).not.toHaveBeenCalled();
  });

  it("shows checking state, then a sign-in link when the session is gone", async () => {
    render(
      <ConsoleShell
        kind="install"
        pathname="/admin/install"
        loadAccess={() => fail(401, "unauthenticated", "Sign in to continue.")}
      >
        <Page />
      </ConsoleShell>,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Checking your access/);
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(pageMounted).not.toHaveBeenCalled();
  });

  it("shows the isolation banner while agents are disabled", async () => {
    stubFetch({
      state: "missing",
      agentsEnabled: false,
      message: "x",
      checkedAt: "",
      docs: "",
    });
    render(
      <ConsoleShell kind="install" pathname="/admin/install/users" loadAccess={install("admin")}>
        <Page />
      </ConsoleShell>,
    );
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toMatch(/isolation runtime is missing/);
    expect(within(banner).getByRole("link").getAttribute("href")).toBe("/admin/install/isolation");
  });
});

describe("team console", () => {
  it("opens for a team admin and names the team", async () => {
    render(
      <ConsoleShell
        kind="team"
        pathname="/admin/team/members"
        loadAccess={team("team_admin", TEAM_ADMIN)}
      >
        <Page />
      </ConsoleShell>,
    );
    expect(await screen.findByRole("heading", { name: "The page" })).toBeTruthy();
    // The switcher names the team and role; the header names the person.
    expect((await screen.findByRole("navigation", { name: "Teams" })).textContent).toMatch(
      /Finance/,
    );
    expect(
      screen.getByRole("link", { name: "Members and roles" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it.each([
    ["member", ["team.read", "team.members.read", "team.agents.use"]],
    ["builder", ["team.read", "team.members.read", "team.agents.use", "team.agents.build"]],
  ] as const)("refuses a %s", async (role, permissions) => {
    render(
      <ConsoleShell kind="team" pathname="/admin/team" loadAccess={team(role, [...permissions])}>
        <Page />
      </ConsoleShell>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/team admins/);
    expect(pageMounted).not.toHaveBeenCalled();
  });

  it("asks to choose a team when none is active", async () => {
    render(
      <ConsoleShell
        kind="team"
        pathname="/admin/team"
        loadAccess={() => fail(409, "no_active_team", "Choose a team first.")}
      >
        <Page />
      </ConsoleShell>,
    );
    expect(await screen.findByRole("link", { name: "Choose a team" })).toBeTruthy();
  });

  it("does not mount a section the role doesn't cover", async () => {
    render(
      <ConsoleShell
        kind="team"
        pathname="/admin/team/budgets"
        loadAccess={team("team_admin", ["team.members.manage"])}
      >
        <Page />
      </ConsoleShell>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/doesn't include this section/);
    expect(pageMounted).not.toHaveBeenCalled();
    // …and only the permitted sections are offered.
    const nav = screen.getByRole("navigation", { name: "Team console sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Members and roles", "Invitations", "Audit view · soon, coming in KOBE-15"]);
  });
});

describe("navigation on narrow screens", () => {
  it("folds the section list behind a labelled toggle", async () => {
    const { container } = render(
      <ConsoleShell kind="install" pathname="/admin/install/users" loadAccess={install("admin")}>
        <Page />
      </ConsoleShell>,
    );
    const toggle = await screen.findByRole("button", { name: "Section: Users" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = container.querySelector(`#${toggle.getAttribute("aria-controls") ?? "missing"}`);
    expect(list).not.toBeNull();
    toggle.click();
    expect(
      (await screen.findByRole("button", { name: "Section: Users" })).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("fresh session without an active team", () => {
  it("offers the switcher and checks again once a team is active", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return calls === 1
        ? fail(409, "no_active_team", "Choose a team first.")
        : team("team_admin", TEAM_ADMIN)();
    };
    render(
      <ConsoleShell kind="team" pathname="/admin/team" loadAccess={load}>
        <Page />
      </ConsoleShell>,
    );
    expect(await screen.findByRole("link", { name: "Choose a team" })).toBeTruthy();
    window.dispatchEvent(new Event(ACTIVE_TEAM_EVENT));
    expect(await screen.findByRole("heading", { name: "The page" })).toBeTruthy();
    expect(calls).toBe(2);
  });
});

describe("isolation banner", () => {
  it("clears when the Isolation page re-checks successfully", async () => {
    stubFetch({ state: "missing", agentsEnabled: false, message: "x", checkedAt: "", docs: "" });
    render(
      <ConsoleShell kind="install" pathname="/admin/install/users" loadAccess={install("admin")}>
        <Page />
      </ConsoleShell>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/isolation runtime is missing/);
    window.dispatchEvent(new CustomEvent(ISOLATION_EVENT, { detail: "verified" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("re-checking access", () => {
  it("shows the checking state again while it asks after kobe:active-team", async () => {
    let release: (v: ApiResult<ConsoleAccess>) => void = () => undefined;
    let calls = 0;
    const load = () => {
      calls += 1;
      if (calls === 1) return team("team_admin", TEAM_ADMIN)();
      return new Promise<ApiResult<ConsoleAccess>>((resolve) => {
        release = resolve;
      });
    };
    render(
      <ConsoleShell kind="team" pathname="/admin/team" loadAccess={load}>
        <Page />
      </ConsoleShell>,
    );
    await screen.findByRole("heading", { name: "The page" });
    window.dispatchEvent(new Event(ACTIVE_TEAM_EVENT));
    expect((await screen.findByText("Checking your access…")).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("heading", { name: "The page" })).toBeNull();
    release({
      ok: true,
      status: 200,
      data: {
        console: "team",
        user,
        team: { id: "t-2", slug: "ops", name: "Ops" },
        role: "team_admin",
        permissions: TEAM_ADMIN,
      },
    });
    expect(await screen.findByRole("heading", { name: "The page" })).toBeTruthy();
  });

  it("never keeps a page's state across teams: pages remount per team", async () => {
    let calls = 0;
    const teams = [
      { id: "t-1", slug: "fin", name: "Finance" },
      { id: "t-2", slug: "ops", name: "Ops" },
    ];
    const load = () =>
      ok<ConsoleAccess>({
        console: "team",
        user,
        team: must(teams[Math.min(calls++, 1)]),
        role: "team_admin",
        permissions: TEAM_ADMIN,
      });
    render(
      <ConsoleShell kind="team" pathname="/admin/team" loadAccess={load}>
        <Page />
      </ConsoleShell>,
    );
    await screen.findByRole("heading", { name: "The page" });
    expect(pageMounted).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(ACTIVE_TEAM_EVENT));
    await waitFor(() => expect(pageMounted).toHaveBeenCalledTimes(2));
  });
});

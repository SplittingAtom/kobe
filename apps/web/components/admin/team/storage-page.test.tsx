// @vitest-environment happy-dom
/** Workspace settings → Storage and history (Workspaces GV2, GV3, MT3; KOBE-581 on KOBE-579). */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../lib/testing/must";
import { renderTeam, stubApi } from "../testing";
import { TeamStoragePage } from "./storage-page";

const view = (over: Record<string, unknown> = {}) => ({
  used_bytes: 4096,
  used_objects: 1500,
  quota_bytes: null,
  max_objects: null,
  default_quota_bytes: 10 * 1024 * 1024 * 1024,
  default_max_objects: 2000000,
  live_bytes: 2048,
  history_bytes: 1024,
  live_objects: 12,
  history_objects: 7,
  history_keep: { mode: "all" },
  history_max_commits: 1000,
  max_mounted_per_member: 20,
  scratchspaces: [{ user_id: "u-me", live_bytes: 512, live_files: 3, objects: 3 }],
  projects: [
    {
      project_id: "p-1",
      slug: "budget",
      name: "Budget",
      commits: 4,
      live_bytes: 2048,
      history_bytes: 1024,
      live_objects: 12,
      history_objects: 7,
    },
  ],
  ...over,
});
const ROSTER = {
  members: [{ user_id: "u-me", name: "Ada", email: "a@x", role: "team_admin", joined_at: "x" }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("storage and history settings (GV2, GV3; ac-1)", () => {
  it("renders bytes and objects per project and member, and the settings in force", async () => {
    stubApi({ "GET /v1/team/storage": [200, view()], "GET /v1/team/members": [200, ROSTER] });
    renderTeam(<TeamStoragePage />);
    const row = must(
      (await screen.findByRole("rowheader", { name: /^Budget/ })).closest("tr"),
    ) as HTMLElement;
    expect(within(row).getByText("2 KB")).toBeTruthy();
    expect(within(row).getByText("1 KB")).toBeTruthy();
    expect(within(row).getByText("4 commits")).toBeTruthy();
    expect(screen.getByText(/1,500 of 2,000,000 objects/)).toBeTruthy();
    expect(await screen.findByRole("rowheader", { name: "Ada" })).toBeTruthy();
    expect(screen.getByText(/Every commit \(at most 1000 per project\)/)).toBeTruthy();
    expect((screen.getByLabelText("Projects mounted per member") as HTMLInputElement).value).toBe(
      "20",
    );
    // Nothing changed yet: nothing to save.
    expect(
      (screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("saves only what changed, snake_case, and shows the answer", async () => {
    const calls = stubApi({
      "GET /v1/team/storage": [200, view()],
      "GET /v1/team/members": [200, ROSTER],
      "PUT /v1/team/storage": [
        200,
        view({ history_keep: { mode: "commits", n: 50 }, max_mounted_per_member: 5 }),
      ],
    });
    renderTeam(<TeamStoragePage />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Project history kept"), "commits");
    expect(screen.getByRole("alert").textContent).toMatch(/how many/);
    await user.type(screen.getByLabelText("Commits to keep"), "50");
    const mounts = screen.getByLabelText("Projects mounted per member");
    await user.clear(mounts);
    await user.type(mounts, "5");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Saved.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      history_keep: { mode: "commits", n: 50 },
      max_mounted_per_member: 5,
    });
    await waitFor(() => expect(screen.getByText(/The newest 50 commits per project/)).toBeTruthy());
  });

  it("an empty object budget returns to the site default (null)", async () => {
    const calls = stubApi({
      "GET /v1/team/storage": [200, view({ max_objects: 5000 })],
      "GET /v1/team/members": [200, ROSTER],
      "PUT /v1/team/storage": [200, view()],
    });
    renderTeam(<TeamStoragePage />);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Object budget"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Saved.");
    expect(JSON.parse(String(calls.find((c) => c.method === "PUT")?.body))).toEqual({
      max_objects: null,
    });
  });
});

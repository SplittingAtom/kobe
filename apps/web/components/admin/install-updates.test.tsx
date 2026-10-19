// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallUpdatesPanel } from "./team/skill-editor/install-updates";
import { renderTeam, stubApi } from "./testing";

/** KOBE-337 (SK25): Update available, the diff, Move pin and Roll back. */
const INSTALL = {
  skillId: "s-1",
  name: "quarterly-report",
  versionId: "v-1",
  semver: "1.0.0",
  pinMode: "within_major",
  access: "default_on",
  origin: "team",
  installedBy: "u-me",
  updatedAt: "2026-10-19T10:00:00Z",
  isDefault: false,
} as const;
const BASE = "/v1/team/skills/installs/s-1";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("install updates", () => {
  it("lists updates with changelog and eval change, shows the diff, moves the pin and rolls back", async () => {
    const calls = stubApi({
      [`GET ${BASE}/updates`]: [
        200,
        {
          skill_id: "s-1",
          name: "quarterly-report",
          pin_mode: "within_major",
          pinned: { version_id: "v-1", semver: "1.0.0" },
          running: { version_id: "v-2", semver: "1.1.0" },
          updates: [
            {
              version_id: "v-3",
              semver: "2.0.0",
              changelog: "Charts.",
              deprecated: false,
              major: true,
              automatic: false,
              eval_delta: { pass_rate: 0.1, lift: 0.2 },
            },
          ],
          rollback_to: "0.9.0",
        },
      ],
      [`GET ${BASE}/diff?to=2.0.0`]: [
        200,
        {
          against: null,
          files: [
            {
              path: "SKILL.md",
              status: "changed",
              size: 5,
              binary: false,
              hunks: [
                { old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["+charts"] },
              ],
            },
          ],
          changed_files: 1,
          truncated: false,
        },
      ],
      [`POST ${BASE}/move`]: [200, { semver: "2.0.0", deprecated: false, required_count: 0 }],
      [`POST ${BASE}/rollback`]: [200, { semver: "0.9.0", deprecated: false, required_count: 0 }],
    });
    const run = vi.fn(async (action: () => Promise<{ ok: boolean }>) => (await action()).ok);
    renderTeam(
      <InstallUpdatesPanel teamId="t-1" install={INSTALL} mayMove pending={false} run={run} />,
    );
    await userEvent.click(screen.getByText("Updates"));
    expect(await screen.findByText("Charts.")).toBeTruthy();
    expect(screen.getByText("major")).toBeTruthy();
    expect(screen.getByText(/never takes a new major/)).toBeTruthy();
    expect(screen.getByText(/pass rate \+10 points, lift \+20 points/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the diff to 2.0.0" }));
    expect(await screen.findByText("+charts")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Move pin to 2.0.0" }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/move`)).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url === `${BASE}/move`)?.body))).toEqual({
      version: "2.0.0",
    });
    await userEvent.click(screen.getByRole("button", { name: "Roll back to 0.9.0" }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/rollback`)).toBe(true));
  });
});

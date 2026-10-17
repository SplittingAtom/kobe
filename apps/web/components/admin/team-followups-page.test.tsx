// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamFollowupsPage } from "./team/followups-page";
import { forbidNativeConfirm, renderTeam, stubApi } from "./testing";

beforeEach(forbidNativeConfirm);

afterEach(cleanup);

describe("Team follow-ups switch (KOBE-222 ac-3)", () => {
  it("is off by default; a team admin turns it on", async () => {
    const calls = stubApi({
      "GET /v1/team/settings": [
        [200, { followups_enabled: false }],
        [200, { followups_enabled: true }],
      ],
      "PUT /v1/team/settings": [200, { followups_enabled: true }],
    });
    renderTeam(<TeamFollowupsPage />);
    const toggle = await screen.findByRole("checkbox", { name: /Suggest follow-up messages/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/skipped once any of their budgets is at 80 %/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Follow-up suggestions are on for this team/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ followups_enabled: true });
  });

  it("turns it off again", async () => {
    const calls = stubApi({
      "GET /v1/team/settings": [200, { followups_enabled: true }],
      "PUT /v1/team/settings": [200, { followups_enabled: false }],
    });
    renderTeam(<TeamFollowupsPage />);
    const toggle = await screen.findByRole("checkbox", { name: /Suggest follow-up messages/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Follow-up suggestions are off for this team/);
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      followups_enabled: false,
    });
  });
});

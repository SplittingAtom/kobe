// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { RetentionMaximumPage } from "./install/retention-page";
import { TeamRetentionPage } from "./team/retention-page";
import { TEAM, renderInstall, renderTeam, stubApi } from "./testing";

const view = (period: string, maximum: string, effective: string, allowed: string[]) => ({
  period,
  maximum,
  effective,
  allowed,
});

let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Team retention (KOBE-18)", () => {
  it("offers the periods within the maximum and saves a shorter one after confirming", async () => {
    const calls = stubApi({
      "GET /v1/team/retention": [
        [200, view("forever", "1y", "1y", ["30d", "90d", "1y"])],
        [200, view("90d", "1y", "90d", ["30d", "90d", "1y"])],
      ],
      "PUT /v1/team/retention": [200, view("90d", "1y", "90d", ["30d", "90d", "1y"])],
    });
    renderTeam(<TeamRetentionPage />);
    // The team chose forever, but the install caps it at a year.
    expect(await screen.findByText(/The install keeps conversations at most 1 year/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Forever" })).toBeNull();
    expect(screen.getByRole("radio", { name: "1 year" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("radio", { name: "90 days" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(confirm).toHaveBeenCalledOnce();
    await screen.findByText(/keeps conversations for 90 days/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ period: "90d" });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("sends nothing when the confirmation is cancelled, and shows the server's refusal", async () => {
    confirm.mockReturnValue(false);
    const calls = stubApi({
      "GET /v1/team/retention": [200, view("1y", "forever", "1y", ["30d", "90d", "1y", "forever"])],
      "PUT /v1/team/retention": [
        409,
        { code: "exceeds_maximum", message: "The install keeps threads at most 90d." },
      ],
    });
    renderTeam(<TeamRetentionPage />);
    await userEvent.click(await screen.findByRole("radio", { name: "30 days" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    // Longer than what applies: no confirmation needed; the server refuses it.
    await userEvent.click(screen.getByRole("radio", { name: "Forever" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at most 90d/);
  });
});

describe("Install retention maximum (KOBE-18)", () => {
  it("lowers the maximum after confirming", async () => {
    const calls = stubApi({
      "GET /v1/install/retention": [
        [200, { maximum: "forever" }],
        [200, { maximum: "1y" }],
      ],
      "PUT /v1/install/retention": [200, { maximum: "1y" }],
    });
    renderInstall(<RetentionMaximumPage />);
    expect(await screen.findByRole("radio", { name: "Forever" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("radio", { name: "1 year" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(confirm).toHaveBeenCalledOnce();
    await screen.findByText("Retention maximum: 1 year.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ maximum: "1y" });
  });
});

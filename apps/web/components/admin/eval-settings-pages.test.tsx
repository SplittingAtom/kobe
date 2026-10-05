// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { must } from "../../lib/testing/must";
import { EvalSettingsPage } from "./team/eval-settings-page";
import { renderTeam, stubApi } from "./testing";

afterEach(cleanup);

describe("Agent evaluation settings (KOBE-93)", () => {
  it("turns the gate on with a threshold in percent and sends it as a rate", async () => {
    const calls = stubApi({
      "GET /v1/team/eval-settings": [
        [200, { enabled: false, maxAttackSuccessRate: 0.2 }],
        [200, { enabled: true, maxAttackSuccessRate: 0.4 }],
      ],
      "PUT /v1/team/eval-settings": [200, { enabled: true, maxAttackSuccessRate: 0.4 }],
    });
    renderTeam(<EvalSettingsPage />);
    const toggle = await screen.findByRole("checkbox", { name: /Require a passing evaluation/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(toggle);
    const limit = screen.getByRole("spinbutton");
    expect((limit as HTMLInputElement).value).toBe("20");
    await userEvent.clear(limit);
    await userEvent.type(limit, "40");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Publishing now runs an evaluation first and is blocked above 40%/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ enabled: true, maxAttackSuccessRate: 0.4 });
  });

  it("refuses a threshold outside 0 to 100", async () => {
    stubApi({ "GET /v1/team/eval-settings": [200, { enabled: true, maxAttackSuccessRate: 0.2 }] });
    renderTeam(<EvalSettingsPage />);
    const limit = await screen.findByRole("spinbutton");
    await userEvent.clear(limit);
    await userEvent.type(limit, "150");
    expect(screen.getByText("Enter a number from 0 to 100.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

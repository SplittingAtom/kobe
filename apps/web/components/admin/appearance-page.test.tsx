// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AppearancePage } from "./site/appearance-page";
import { answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "./testing";

const BRANDING = {
  appName: "Kobe",
  showName: true,
  logo: null,
  favicon: null,
  theme: { preset: "default" },
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const save = () => screen.getByRole("button", { name: "Save" });

describe("site Appearance page (KOBE-501)", () => {
  it("saves only what changed, then reloads to show the real header", async () => {
    const calls = stubApi({
      "GET /v1/site/branding": [200, BRANDING],
      "PUT /v1/site/branding": [200, { ...BRANDING, appName: "Acme", theme: { preset: "plum" } }],
    });
    const reload = vi.fn();
    renderSite(<AppearancePage reloadPage={reload} />);
    const name = await screen.findByLabelText(/^Site name/);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, " Acme ");
    await userEvent.click(screen.getByRole("radio", { name: "Plum" }));
    await userEvent.click(save());
    await screen.findByText(/Saved\./);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ appName: "Acme", theme: { preset: "plum" } });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps Save off with the ratio while the accent is under the floor", async () => {
    stubApi({ "GET /v1/site/branding": [200, BRANDING] });
    renderSite(<AppearancePage reloadPage={vi.fn()} />);
    await userEvent.click(await screen.findByRole("radio", { name: "Custom" }));
    const hex = screen.getByLabelText("Accent colour");
    await userEvent.clear(hex);
    await userEvent.type(hex, "#f4f4f6");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    const reason = must(document.getElementById(must(save().getAttribute("aria-describedby"))));
    expect(reason.textContent).toMatch(
      /Save is off until the accent meets the contrast floor: .*\d:1/,
    );
  });

  it("shows the server's contrast failures when it refuses the accent", async () => {
    stubApi({
      "GET /v1/site/branding": [200, BRANDING],
      "PUT /v1/site/branding": [
        422,
        {
          code: "contrast_floor",
          message:
            "This accent does not reach the contrast floor (fg_on_primary: 4.2:1, needs 4.5:1).",
          failures: [{ rule: "fg_on_primary", scheme: "dark", ratio: 4.2, required: 4.5 }],
        },
      ],
    });
    const reload = vi.fn();
    renderSite(<AppearancePage reloadPage={reload} />);
    await userEvent.click(await screen.findByRole("radio", { name: "Custom" }));
    await userEvent.click(save());
    expect(await screen.findByText(/This accent does not reach the contrast floor/)).toBeTruthy();
    expect(
      screen.getByText(
        "Text on the accent is too faint in the dark theme (4.2:1; it needs 4.5:1).",
      ),
    ).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("resets to Kobe's defaults after asking", async () => {
    const calls = stubApi({
      "GET /v1/site/branding": [200, { ...BRANDING, appName: "Acme" }],
      "POST /v1/site/branding/reset": [200, BRANDING],
    });
    const reload = vi.fn();
    renderSite(<AppearancePage reloadPage={reload} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset to Kobe defaults" }));
    const text = await answerConfirm(/Reset the appearance/, "Reset");
    expect(text).toMatch(/name, the logos, the favicon and the style/);
    await screen.findByText(/Reset to Kobe's defaults/);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("POST /v1/site/branding/reset");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("previews the draft name before it is saved", async () => {
    stubApi({ "GET /v1/site/branding": [200, BRANDING] });
    renderSite(<AppearancePage reloadPage={vi.fn()} />);
    const name = await screen.findByLabelText(/^Site name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Acme");
    expect(must(document.getElementById("preview-dark")).textContent).toContain("Acme");
  });
});

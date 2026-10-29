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
      "POST /api/branding/refresh": [204],
    });
    const reload = vi.fn();
    renderSite(<AppearancePage reloadPage={reload} />);
    const name = await screen.findByLabelText(/^Site name/);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, " Acme ");
    await userEvent.click(screen.getByRole("radio", { name: "Plum" }));
    await userEvent.click(save());
    await screen.findByText("Saved. Reloading…");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ appName: "Acme", theme: { preset: "plum" } });
    // This web process refetches the branding before the reload, so it shows the change.
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(-2)).toEqual([
      "PUT /v1/site/branding",
      "POST /api/branding/refresh",
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Other web replicas pick the change up within 30 seconds."),
    ).toBeTruthy();
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
    // Editing the draft clears the refusal: it no longer describes it.
    await userEvent.click(screen.getByRole("radio", { name: "Round" }));
    expect(screen.queryByText(/This accent does not reach the contrast floor/)).toBeNull();
    expect(
      screen.queryByText(/Text on the accent is too faint in the dark theme \(4\.2/),
    ).toBeNull();
  });

  it("refetches the branding and reloads after an upload", async () => {
    const calls = stubApi({
      "GET /v1/site/branding": [200, BRANDING],
      "PUT /v1/site/branding/assets/favicon": [
        200,
        { ...BRANDING, favicon: "/v1/site/branding/assets/favicon?v=1" },
      ],
      "POST /api/branding/refresh": [204],
    });
    const reload = vi.fn();
    renderSite(<AppearancePage reloadPage={reload} />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "f.png", { type: "image/png" });
    await userEvent.upload(await screen.findByLabelText("Favicon file"), file);
    await screen.findByText("Favicon saved. Reloading…");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("POST /api/branding/refresh");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("resets to Kobe's defaults after asking", async () => {
    const calls = stubApi({
      "GET /v1/site/branding": [200, { ...BRANDING, appName: "Acme" }],
      "POST /v1/site/branding/reset": [200, BRANDING],
      "POST /api/branding/refresh": [204],
    });
    const reload = vi.fn();
    renderSite(<AppearancePage reloadPage={reload} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    const text = await answerConfirm(/Reset the appearance/, "Reset");
    expect(text).toMatch(/name, the logos, the favicon and the style/);
    await screen.findByText(/Defaults restored/);
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

// @vitest-environment happy-dom
import { BRANDING_ASSET_CONTENT_TYPES, type SiteBranding } from "@kobe/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { brandingCss } from "../../lib/theme/branding-css";
import { AssetField } from "./site/appearance-asset";
import { IdentityFields } from "./site/appearance-identity";
import { AppearancePreview } from "./site/appearance-preview";
import { StylePicker, draftOf, themeOf, type StyleDraft } from "./site/appearance-style";
import { stubApi } from "./testing";

const BRANDING: SiteBranding = {
  appName: "Acme",
  showName: true,
  logo: null,
  favicon: null,
  theme: { preset: "default" },
};
const WITH_LOGO: SiteBranding = {
  ...BRANDING,
  logo: {
    url: "/v1/site/branding/assets/logo?v=a1",
    dark: "/v1/site/branding/assets/logo_dark?v=b2",
  },
  favicon: "/v1/site/branding/assets/favicon?v=c3",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Identity({ initial = "Acme" }: { initial?: string }) {
  const [name, setName] = useState(initial);
  const [show, setShow] = useState(true);
  return <IdentityFields appName={name} onAppName={setName} showName={show} onShowName={setShow} />;
}

describe("Appearance identity", () => {
  it("counts characters and shows the title example live", async () => {
    render(<Identity />);
    const input = screen.getByLabelText(/^Site name/);
    expect(screen.getByText("4 of 40 characters")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "Acme Data");
    expect(screen.getByText("9 of 40 characters")).toBeTruthy();
    expect(screen.getByText("Site console · Acme Data")).toBeTruthy();
  });

  it("names the rule an invalid name breaks", async () => {
    render(<Identity />);
    const input = screen.getByLabelText(/^Site name/);
    await userEvent.clear(input);
    expect(screen.getByRole("alert").textContent).toBe("The name must be 1 to 40 characters");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await userEvent.type(input, "x".repeat(41));
    expect(screen.getByText("41 of 40 characters")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The name must be 1 to 40 characters");
  });

  it("offers to hide the name next to the logo", async () => {
    render(<Identity />);
    const box = screen.getByRole("checkbox", { name: "Show the name next to the logo" });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
  });
});

describe("Appearance uploads", () => {
  it("accepts the server's types per kind and shows the size limits", () => {
    render(
      <>
        <AssetField kind="logo" branding={BRANDING} onChanged={() => undefined} />
        <AssetField kind="favicon" branding={BRANDING} onChanged={() => undefined} />
      </>,
    );
    const logo = screen.getByLabelText("Logo file") as HTMLInputElement;
    for (const type of BRANDING_ASSET_CONTENT_TYPES.logo) expect(logo.accept).toContain(type);
    expect(logo.accept).not.toContain("image/x-icon");
    const favicon = screen.getByLabelText("Favicon file") as HTMLInputElement;
    for (const type of BRANDING_ASSET_CONTENT_TYPES.favicon) expect(favicon.accept).toContain(type);
    expect(screen.getByText(/PNG, JPEG, WebP or SVG, up to 512 KiB/)).toBeTruthy();
    expect(screen.getByText(/PNG, SVG or ICO, up to 256 KiB/)).toBeTruthy();
  });

  it("uploads the picked file and hands back the new branding", async () => {
    const calls = stubApi({ "PUT /v1/site/branding/assets/logo": [200, WITH_LOGO] });
    const onChanged = vi.fn();
    render(<AssetField kind="logo" branding={BRANDING} onChanged={onChanged} />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "acme.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Logo file"), file);
    await screen.findByText(/Logo saved/);
    expect(onChanged).toHaveBeenCalledWith(WITH_LOGO);
    expect(((must(calls[0]).body as FormData).get("file") as File).name).toBe("acme.png");
  });

  it("shows the server's refusal verbatim, with the Plain SVG hint for an SVG", async () => {
    stubApi({
      "PUT /v1/site/branding/assets/logo": [
        422,
        { code: "svg_refused", message: "This SVG is refused: it contains a <script> element" },
      ],
    });
    render(<AssetField kind="logo" branding={BRANDING} onChanged={() => undefined} />);
    const file = new File(["<svg><script/></svg>"], "bad.svg", { type: "image/svg+xml" });
    await userEvent.upload(screen.getByLabelText("Logo file"), file);
    expect(
      await screen.findByText("This SVG is refused: it contains a <script> element"),
    ).toBeTruthy();
    expect(
      screen.getByText("Export the file as Plain SVG (Inkscape's own format is refused)."),
    ).toBeTruthy();
  });

  it("refuses a file over the limit before sending it", async () => {
    const calls = stubApi({});
    render(<AssetField kind="favicon" branding={BRANDING} onChanged={() => undefined} />);
    const big = new File([new Uint8Array(257 * 1024)], "huge.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Favicon file"), big);
    expect(await screen.findByText(/huge\.png is 257 KiB; the limit here is 256 KiB/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows the current logo on light and dark and removes it", async () => {
    const calls = stubApi({ "DELETE /v1/site/branding/assets/logo": [200, BRANDING] });
    const onChanged = vi.fn();
    render(<AssetField kind="logo" branding={WITH_LOGO} onChanged={onChanged} />);
    const shown = screen.getAllByRole("img").map((i) => i.getAttribute("src"));
    expect(shown).toEqual([must(WITH_LOGO.logo).url, must(WITH_LOGO.logo).url]);
    await userEvent.click(screen.getByRole("button", { name: "Remove the logo" }));
    await screen.findByText(/Logo removed/);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /v1/site/branding/assets/logo",
    ]);
    expect(onChanged).toHaveBeenCalledWith(BRANDING);
  });

  it("previews the favicon at 16 and 32 px", () => {
    render(<AssetField kind="favicon" branding={WITH_LOGO} onChanged={() => undefined} />);
    const sizes = screen.getAllByRole("img").map((i) => i.getAttribute("width"));
    expect(sizes).toEqual(["16", "32"]);
  });
});

function Style({ initial }: { initial: StyleDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <StylePicker draft={draft} onDraft={setDraft} />
      <output data-testid="theme">{JSON.stringify(themeOf(draft))}</output>
    </>
  );
}

const theme = () => JSON.parse(screen.getByTestId("theme").textContent ?? "null") as unknown;

describe("Appearance style", () => {
  it("offers the six presets and Custom as one radio group", async () => {
    render(<Style initial={draftOf({ preset: "default" })} />);
    const group = screen.getByRole("group", { name: "Style" });
    const names = within(group)
      .getAllByRole("radio")
      .map((r) => r.closest("label")?.textContent?.trim());
    expect(names).toEqual([
      "Default",
      "Slate",
      "Forest",
      "Plum",
      "Ember",
      "Tokyo Nights",
      "Custom",
    ]);
    await userEvent.click(screen.getByRole("radio", { name: "Plum" }));
    expect(theme()).toEqual({ preset: "plum" });
  });

  it("turns a custom accent into a contrast line", async () => {
    render(<Style initial={draftOf({ preset: "default" })} />);
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const hex = screen.getByLabelText("Accent colour");
    await userEvent.clear(hex);
    await userEvent.type(hex, "#0F766E");
    expect(theme()).toEqual({
      preset: "custom",
      accent: "#0f766e",
      corners: "soft",
      font: "system",
    });
    expect(screen.getByText(/^Accent text: white, \d+\.\d:1 light/)).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Round" }));
    await userEvent.click(screen.getByRole("radio", { name: "Serif" }));
    expect(theme()).toMatchObject({ corners: "round", font: "serif" });
  });

  it("lists the failures of an accent under the floor", async () => {
    render(
      <Style
        initial={draftOf({ preset: "custom", accent: "#f4f4f6", corners: "soft", font: "system" })}
      />,
    );
    expect(
      screen.getAllByText(/The accent barely stands out from the background in the light theme/),
    ).not.toHaveLength(0);
  });

  it("asks for #rrggbb when the hex is incomplete", async () => {
    render(
      <Style
        initial={draftOf({ preset: "custom", accent: "#2449c7", corners: "soft", font: "system" })}
      />,
    );
    const hex = screen.getByLabelText("Accent colour");
    await userEvent.clear(hex);
    await userEvent.type(hex, "#12");
    expect(screen.getByRole("alert").textContent).toMatch(/#rrggbb/);
    expect(theme()).toBeNull();
  });

  it("keeps the colour picker and the hex field in step", async () => {
    render(
      <Style
        initial={draftOf({ preset: "custom", accent: "#2449c7", corners: "soft", font: "system" })}
      />,
    );
    const picker = screen.getByLabelText("Pick the accent colour") as HTMLInputElement;
    expect(picker.type).toBe("color");
    expect(picker.value).toBe("#2449c7");
  });
});

describe("Appearance preview", () => {
  it("styles a light and a dark root with the real branding CSS, nonced", () => {
    const script = document.createElement("script");
    script.setAttribute("nonce", "n0nce");
    script.nonce = "n0nce";
    document.head.append(script);
    render(<AppearancePreview branding={BRANDING} theme={{ preset: "plum" }} />);
    const style = must(document.querySelector("style[data-kobe-preview]"));
    expect(style.textContent).toContain(brandingCss({ preset: "plum" }, "#preview-light"));
    expect(style.textContent).toContain(brandingCss({ preset: "plum" }, "#preview-dark"));
    expect(style.getAttribute("nonce")).toBe("n0nce");
    expect(must(document.getElementById("preview-light")).getAttribute("data-theme")).toBe("light");
    expect(must(document.getElementById("preview-dark")).getAttribute("data-theme")).toBe("dark");
    script.remove();
  });

  it("shows the brand, a primary button, a link, three status chips and a field in each", () => {
    render(<AppearancePreview branding={BRANDING} theme={{ preset: "default" }} />);
    for (const id of ["preview-light", "preview-dark"]) {
      const root = must(document.getElementById(id));
      expect(root.textContent).toContain("Acme");
      expect(
        root.querySelector('[data-slot="console-button"][data-variant="primary"]'),
      ).not.toBeNull();
      expect(root.querySelector("a")).not.toBeNull();
      expect(root.querySelectorAll('[data-slot="console-badge"]')).toHaveLength(3);
      expect(root.querySelector("input")).not.toBeNull();
      expect(root.hasAttribute("inert")).toBe(true);
    }
  });
});

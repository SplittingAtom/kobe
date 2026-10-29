// @vitest-environment happy-dom
import type { SiteBranding } from "@kobe/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BRANDING } from "../../lib/theme/branding-defaults";
import { Brand } from "./brand";
import { AppName, BrandingProvider } from "./branding-context";

/** KOBE-500: the bar's and consoles' brand: name, logo, dark logo, accessible name. */
afterEach(cleanup);

function renderBrand(branding: Partial<SiteBranding> = {}) {
  return render(
    <BrandingProvider value={{ ...DEFAULT_BRANDING, ...branding }}>
      <h1 data-testid="h">
        <Brand />
      </h1>
    </BrandingProvider>,
  );
}

const LOGO = "/v1/site/branding/assets/logo?v=ab";
const DARK = "/v1/site/branding/assets/logo_dark?v=cd";

describe("<Brand />", () => {
  it("with nothing configured is the text Kobe and nothing else, as before branding", () => {
    renderBrand();
    expect(screen.getByTestId("h").innerHTML).toBe("Kobe");
    render(
      <p data-testid="p">
        <Brand />
      </p>,
    );
    expect(screen.getByTestId("p").innerHTML).toBe("Kobe");
  });

  it("shows a configured name", () => {
    renderBrand({ appName: "Acme Research" });
    expect(screen.getByRole("heading", { name: "Acme Research" })).toBeTruthy();
  });

  it("puts the logo next to the name, decorative, 24 px tall", () => {
    renderBrand({ appName: "Acme", logo: { url: LOGO } });
    const imgs = screen.getByTestId("h").querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    const img = imgs[0] as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(LOGO);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("height")).toBe("24");
    expect(img.getAttribute("width")).toBeNull();
    expect(img.hasAttribute("decoding")).toBe(false);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeTruthy();
  });

  it("swaps to the dark logo through the theme's display tokens", () => {
    renderBrand({ logo: { url: LOGO, dark: DARK } });
    const light = screen.getByTestId("h").querySelector('img[data-logo="light"]');
    const dark = screen.getByTestId("h").querySelector('img[data-logo="dark"]');
    expect(light?.getAttribute("src")).toBe(LOGO);
    expect(dark?.getAttribute("src")).toBe(DARK);
    expect(light?.className).toMatch(/whenLight/);
    expect(dark?.className).toMatch(/whenDark/);
  });

  it("keeps the name as the accessible name when it is hidden next to the logo", () => {
    renderBrand({ appName: "Acme", showName: false, logo: { url: LOGO } });
    expect(screen.getByRole("heading", { name: "Acme" })).toBeTruthy();
    const name = screen.getByText("Acme");
    expect(name.className).toBe("sr-only");
  });

  it("reserves the logo's space from its known size, scaled to 24 px tall", () => {
    renderBrand({
      logo: { url: LOGO, dark: DARK, width: 400, height: 100, darkWidth: 90, darkHeight: 60 },
    });
    const light = screen.getByTestId("h").querySelector('img[data-logo="light"]');
    const dark = screen.getByTestId("h").querySelector('img[data-logo="dark"]');
    expect([light?.getAttribute("width"), light?.getAttribute("height")]).toEqual(["96", "24"]);
    expect([dark?.getAttribute("width"), dark?.getAttribute("height")]).toEqual(["36", "24"]);
  });

  it("ignores showName without a logo: the name is the brand", () => {
    renderBrand({ appName: "Acme", showName: false });
    expect(screen.getByTestId("h").innerHTML).toBe("Acme");
  });
});

describe("<AppName />", () => {
  it("is the branding's name, Kobe without a provider", () => {
    render(
      <p data-testid="a">
        Back to <AppName />
      </p>,
    );
    expect(screen.getByTestId("a").textContent).toBe("Back to Kobe");
  });
});

describe("server render (ac-4: no client flash)", () => {
  it("the first HTML already carries the configured name and logos", () => {
    const html = renderToString(
      <BrandingProvider
        value={{ ...DEFAULT_BRANDING, appName: "Acme", logo: { url: LOGO, dark: DARK } }}
      >
        <h1>
          <Brand />
        </h1>
      </BrandingProvider>,
    );
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain(`src="${DARK}"`);
    expect(html).toContain(">Acme</span>");
    expect(html).not.toContain("Kobe");
  });
});

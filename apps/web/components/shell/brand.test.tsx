// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANDING } from "../../lib/theme/branding-defaults";
import { Brand } from "./brand";
import { AppName, BrandingProvider, type ShellBranding } from "./branding-context";

/** KOBE-500: the bar's and consoles' brand: name, logo, dark logo, accessible name. */
afterEach(cleanup);

function renderBrand(branding: Partial<ShellBranding> = {}) {
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

describe("<Brand /> with the logo theme colour (KOBE-562)", () => {
  const INLINE = "/v1/site/branding/assets/logo?inline=1&v=12";
  const MARKUP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10" fill="currentColor">' +
    '<path d="M0 0h40v10z"/></svg>';

  it("inlines the variant the server render fetched, decorative, beside the name", () => {
    renderBrand({
      appName: "Acme",
      logoThemeColor: true,
      logo: { url: LOGO, inline: INLINE, width: 40, height: 10 },
      logoSvg: MARKUP,
    });
    const h = screen.getByTestId("h");
    expect(h.querySelector("img")).toBeNull();
    const host = h.querySelector('[data-logo="inline"]') as HTMLElement;
    expect(host.classList.contains("logo")).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
    const svg = host.querySelector("svg");
    expect([svg?.getAttribute("width"), svg?.getAttribute("height")]).toEqual(["96", "24"]);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeTruthy();
  });

  it("is in the first HTML (no flash, no asset swap on a theme change)", () => {
    const html = renderToString(
      <BrandingProvider
        value={{
          ...DEFAULT_BRANDING,
          logoThemeColor: true,
          logo: { url: LOGO, inline: INLINE },
          logoSvg: MARKUP,
        }}
      >
        <Brand />
      </BrandingProvider>,
    );
    expect(html).toContain('<path d="M0 0h40v10z"/>');
    expect(html).not.toContain("<img");
  });

  it("fetches the variant in the browser when only its URL is known (the Appearance preview)", async () => {
    const fetchMock = vi.fn(
      async () => new Response(MARKUP, { headers: { "content-type": "image/svg+xml" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderBrand({ logoThemeColor: true, logo: { url: LOGO, inline: `${INLINE}3` } });
      // Until it arrives, the upload shows as an image, as with the setting off.
      expect(screen.getByTestId("h").querySelector("img")?.getAttribute("src")).toBe(LOGO);
      await vi.waitFor(() =>
        expect(screen.getByTestId("h").querySelector('[data-logo="inline"] svg')).not.toBeNull(),
      );
      expect(screen.getByTestId("h").querySelector("img")).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(`${INLINE}3`, expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the image when the logo has no inline variant (raster, or the setting off)", () => {
    renderBrand({ logoThemeColor: true, logo: { url: LOGO, dark: DARK }, logoSvg: MARKUP });
    expect(screen.getByTestId("h").querySelectorAll("img")).toHaveLength(2);
    expect(screen.getByTestId("h").querySelector('[data-logo="inline"]')).toBeNull();
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

import type { SiteBranding } from "@kobe/protocol";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANDING } from "../lib/theme/branding-defaults";

/** KOBE-282 (ac-2): the root layout reads the theme cookie, so the first paint is in that theme. */
let cookie: string | undefined;
let branding: SiteBranding = DEFAULT_BRANDING;
const NONCE = "bm9uY2Utb2YtdGhpcy1yZXF1ZXN0";
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "kobe-theme" && cookie !== undefined ? { value: cookie } : undefined,
  }),
  headers: async () => new Headers({ "x-nonce": NONCE }),
}));
vi.mock("../lib/theme/branding-server", () => ({ getSiteBranding: async () => branding }));

const { default: RootLayout, generateMetadata } = await import("./layout");

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

async function html(): Promise<El> {
  const el = await RootLayout({ children: null });
  if (!isValidElement(el)) throw new Error("not an element");
  return el as El;
}

/** The direct element children of an element, falsy ones dropped. */
const kids = (el: El): El[] =>
  ([] as unknown[]).concat(el.props.children).filter((c): c is El => isValidElement(c));

afterEach(() => {
  cookie = undefined;
  branding = DEFAULT_BRANDING;
});

describe("root layout theme (KOBE-282)", () => {
  it("sets <html data-theme> from a saved choice", async () => {
    cookie = "dark";
    expect((await html()).props["data-theme"]).toBe("dark");
    cookie = "light";
    expect((await html()).props["data-theme"]).toBe("light");
  });

  it("leaves it unset (follow the OS) without a valid choice", async () => {
    expect((await html()).props["data-theme"]).toBeUndefined();
    cookie = "neon";
    expect((await html()).props["data-theme"]).toBeUndefined();
  });
});

describe("root layout branding (KOBE-500)", () => {
  it("with nothing configured: no <head> of its own, titled Kobe, the shipped icon", async () => {
    const root = await html();
    expect(kids(root).map((k) => k.type)).toEqual(["body"]);
    expect(await generateMetadata()).toEqual({
      title: { default: "Kobe", template: "%s · Kobe" },
      description: "Self-hosted conversational agent platform",
    });
  });

  it("a theme becomes one nonced <style> in <head>", async () => {
    branding = { ...DEFAULT_BRANDING, theme: { preset: "plum" } };
    const [head, body] = kids(await html());
    expect(head?.type).toBe("head");
    expect(body?.type).toBe("body");
    const [style] = kids(head as El);
    expect(style?.type).toBe("style");
    expect(style?.props.nonce).toBe(NONCE);
    expect(String(style?.props.children)).toMatch(/^:root \{\n {2}--background: /);
  });

  it("names and icons come from the branding", async () => {
    branding = {
      ...DEFAULT_BRANDING,
      appName: "Acme",
      favicon: "/v1/site/branding/assets/favicon?v=1",
    };
    expect(await generateMetadata()).toEqual({
      title: { default: "Acme", template: "%s · Acme" },
      description: "Self-hosted conversational agent platform",
      icons: { icon: "/v1/site/branding/assets/favicon?v=1" },
    });
  });

  it("provides the branding to the client components", async () => {
    branding = { ...DEFAULT_BRANDING, appName: "Acme" };
    const body = kids(await html()).find((k) => k.type === "body") as El;
    const provider = kids(body).find((k) => k.props.value !== undefined);
    expect(provider?.props.value).toEqual(branding);
  });
});

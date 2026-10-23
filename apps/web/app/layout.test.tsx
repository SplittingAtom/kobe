import { isValidElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** KOBE-282 (ac-2): the root layout reads the theme cookie, so the first paint is in that theme. */
let cookie: string | undefined;
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "kobe-theme" && cookie !== undefined ? { value: cookie } : undefined,
  }),
}));

const { default: RootLayout, metadata } = await import("./layout");
const { CLIENT_BUILD_ID } = await import("../lib/build/build-id");

async function html(): Promise<ReactElement<Record<string, unknown>>> {
  const el = await RootLayout({ children: null });
  if (!isValidElement(el)) throw new Error("not an element");
  return el as ReactElement<Record<string, unknown>>;
}

afterEach(() => {
  cookie = undefined;
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

describe("root layout build id (KOBE-487)", () => {
  it("names the page's build in a meta tag", () => {
    expect(metadata.other).toEqual({ "kobe-build": CLIENT_BUILD_ID });
  });
});

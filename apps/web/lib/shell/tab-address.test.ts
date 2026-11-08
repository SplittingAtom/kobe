// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { showTabInAddress } from "./tab-address";

afterEach(() => vi.restoreAllMocks());

describe("showTabInAddress (Skills, Agents)", () => {
  it("puts the tab in the address without a navigation, keeping other parameters", () => {
    window.history.replaceState(null, "", "/agents?x=1");
    showTabInAddress("team");
    expect(window.location.pathname).toBe("/agents");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("team");
    expect(new URLSearchParams(window.location.search).get("x")).toBe("1");
  });

  it("leaves an address that already names the tab alone, and survives a refusal", () => {
    window.history.replaceState(null, "", "/agents?tab=site");
    const replace = vi.spyOn(window.history, "replaceState");
    showTabInAddress("site");
    expect(replace).not.toHaveBeenCalled();
    replace.mockImplementation(() => {
      throw new Error("refused");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => showTabInAddress("team")).not.toThrow();
  });
});

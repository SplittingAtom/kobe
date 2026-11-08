// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TAB_KEY,
  agentTabParam,
  openingAgentTab,
  rememberAgentTab,
  rememberedAgentTab,
  showAgentTabInAddress,
} from "./tabs";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("Agents page tabs (KOBE-569, AR1)", () => {
  it("reads ?tab=: null without one, Personal for a value that is no tab", () => {
    expect(agentTabParam(undefined)).toBeNull();
    expect(agentTabParam("site")).toBe("site");
    expect(agentTabParam(["team", "site"])).toBe("team");
    expect(agentTabParam("gallery")).toBe("personal");
  });

  it("opens the address's tab, else the last one used in this browser, else Personal", () => {
    expect(openingAgentTab(null)).toBe("personal");
    rememberAgentTab("site");
    expect(localStorage.getItem(AGENT_TAB_KEY)).toBe("site");
    expect(openingAgentTab(null)).toBe("site");
    expect(openingAgentTab("team")).toBe("team");
  });

  it("ignores a stored value that is no tab, and storage that refuses", () => {
    localStorage.setItem(AGENT_TAB_KEY, "nonsense");
    expect(rememberedAgentTab()).toBeNull();
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(() => rememberAgentTab("team")).not.toThrow();
    expect(openingAgentTab(null)).toBe("personal");
  });

  it("puts the tab in the address without a navigation", () => {
    window.history.replaceState(null, "", "/agents");
    showAgentTabInAddress("team");
    expect(window.location.search).toBe("?tab=team");
  });
});

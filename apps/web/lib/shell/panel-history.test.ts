// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followWorkspaceEntries, stepsBackToWorkspace } from "./panel-history";
import { FakeNavigation } from "./testing/fake-navigation";

/** KOBE-452 (ac-2): Close goes back to the chat it was opened from, never forward of it. */
let nav: FakeNavigation;

beforeEach(() => {
  sessionStorage.clear();
  nav = new FakeNavigation("/?thread=a");
  vi.stubGlobal("navigation", nav);
});

afterEach(() => vi.unstubAllGlobals());

const onChat = () => !nav.url.startsWith("/admin") && !nav.url.startsWith("/me");

describe("stepsBackToWorkspace (KOBE-452)", () => {
  it("goes back past every step taken inside the panel", () => {
    const stop = followWorkspaceEntries(onChat);
    nav.push("/?thread=b");
    nav.push("/admin/team");
    expect(stepsBackToWorkspace()).toBe(-1);
    nav.push("/admin/team/members");
    nav.push("/admin/team/usage");
    expect(stepsBackToWorkspace()).toBe(-3);
    // Replacing inside the panel (a tab in the address) takes no step.
    nav.replace("/admin/team/usage?tab=2");
    expect(stepsBackToWorkspace()).toBe(-3);
    stop();
  });

  it("returns to the thread on screen when the panel opened, not an earlier one", () => {
    const stop = followWorkspaceEntries(onChat);
    nav.push("/?thread=b");
    nav.push("/me/skills");
    nav.go(-1);
    nav.push("/?thread=c");
    nav.push("/me/memory");
    expect(stepsBackToWorkspace()).toBe(-1);
    expect(nav.entries()[nav.index - 1]?.url).toBe("/?thread=c");
    stop();
  });

  it("a deep link or a new tab has no chat to go back to", () => {
    nav = new FakeNavigation("/admin/site");
    vi.stubGlobal("navigation", nav);
    const stop = followWorkspaceEntries(onChat);
    expect(stepsBackToWorkspace()).toBeNull();
    nav.push("/admin/site/users");
    expect(stepsBackToWorkspace()).toBeNull();
    stop();
  });

  it("a chat entry the history no longer holds (cut off by a new branch) is not used", () => {
    const stop = followWorkspaceEntries(onChat);
    nav.push("/me/memory");
    stop();
    // Another branch replaced the chat entry this tab remembered.
    nav.go(-1);
    nav.replaceEntryKey(nav.index, "other");
    nav.go(1);
    expect(stepsBackToWorkspace()).toBeNull();
  });

  it("without the Navigation API Close replaces instead", () => {
    vi.stubGlobal("navigation", undefined);
    const stop = followWorkspaceEntries(onChat);
    expect(stepsBackToWorkspace()).toBeNull();
    stop();
  });
});

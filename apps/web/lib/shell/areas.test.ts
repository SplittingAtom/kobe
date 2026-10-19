// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { areaFromUrl, areaOfHref, openBeside, showArea } from "./areas";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("My area pages beside the thread (CE4, KOBE-424)", () => {
  it("names the four pages CE4 puts beside the thread, and no other", () => {
    expect(areaOfHref("/me/memory")).toBe("memory");
    expect(areaOfHref("/me/approvals?x=1")).toBe("approvals");
    expect(areaOfHref("/me/schedules")).toBe("schedules");
    expect(areaOfHref("/me/connectors#keys")).toBe("connectors");
    for (const page of ["/me/agents", "/me/skills", "/me/projects", "/me/shared-cases", "/admin"])
      expect(areaOfHref(page), page).toBeUndefined();
    expect(areaFromUrl("?area=memory&thread=x")).toBe("memory");
    expect(areaFromUrl("?area=skills")).toBeUndefined();
    expect(areaFromUrl("?area=__proto__")).toBeUndefined();
  });

  it("opens beside on the chat page only, keeping the thread, as a history entry", () => {
    window.history.replaceState(null, "", "/?thread=t-1");
    const before = window.history.length;
    expect(openBeside("/me/memory")).toBe(true);
    expect(window.location.search).toBe("?thread=t-1&area=memory");
    expect(window.history.length).toBe(before + 1);
    showArea(undefined);
    expect(window.location.search).toBe("?thread=t-1");
    expect(openBeside("/me/agents")).toBe(false);
    window.history.replaceState(null, "", "/admin/team");
    expect(openBeside("/me/memory")).toBe(false);
  });
});

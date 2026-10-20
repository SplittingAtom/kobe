// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { draftTabParam, openingDraftTab, rememberDraftTab, rememberedDraftTab } from "./draft-tabs";

/** KOBE-459 ac-6: the draft page's tab from `?tab=`, else the one last used for that draft. */
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("draftTabParam", () => {
  it("reads define, test and eval; no value is null; anything else is Define", () => {
    expect(draftTabParam("test")).toBe("test");
    expect(draftTabParam(["eval", "test"])).toBe("eval");
    expect(draftTabParam("define")).toBe("define");
    expect(draftTabParam(undefined)).toBeNull();
    expect(draftTabParam("files")).toBe("define");
    expect(draftTabParam("")).toBe("define");
  });
});

describe("the remembered tab", () => {
  it("is kept per draft", () => {
    rememberDraftTab("d-1", "eval");
    rememberDraftTab("d-2", "test");
    expect(rememberedDraftTab("d-1")).toBe("eval");
    expect(rememberedDraftTab("d-2")).toBe("test");
    expect(rememberedDraftTab("d-3")).toBeNull();
  });

  it("ignores a stored value that is no tab, and storage that throws", () => {
    localStorage.setItem("kobe.workbench.tab.d-1", "nonsense");
    expect(rememberedDraftTab("d-1")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(rememberedDraftTab("d-1")).toBeNull();
    expect(() => rememberDraftTab("d-1", "test")).not.toThrow();
  });
});

describe("openingDraftTab", () => {
  it("prefers the address, then the remembered tab, then Define", () => {
    rememberDraftTab("d-1", "eval");
    expect(openingDraftTab("test", "d-1")).toBe("test");
    expect(openingDraftTab(null, "d-1")).toBe("eval");
    expect(openingDraftTab(null, "d-2")).toBe("define");
    // An unknown ?tab= was read as Define: it wins over the remembered tab.
    expect(openingDraftTab(draftTabParam("bogus"), "d-1")).toBe("define");
  });
});

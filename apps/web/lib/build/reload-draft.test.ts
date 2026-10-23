// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  isReloadRequested,
  requestReload,
  resetReloadRequest,
  stashDraftForReload,
  takeReloadDraft,
} from "./reload-draft";

/** KOBE-487 ac-4: the banner's Reload keeps the composer's draft for the reloaded page. */
afterEach(() => {
  resetReloadRequest();
  sessionStorage.clear();
});

describe("reload drafts", () => {
  it("keeps a draft only when the banner's Reload unloads the page", () => {
    stashDraftForReload("t1", "half a thought");
    expect(takeReloadDraft("t1")).toBeUndefined();
    requestReload();
    expect(isReloadRequested()).toBe(true);
    stashDraftForReload("t1", "half a thought");
    expect(takeReloadDraft("t2")).toBeUndefined();
    expect(takeReloadDraft("t1")).toBe("half a thought");
    expect(takeReloadDraft("t1")).toBeUndefined(); // taken once
  });

  it("keeps nothing for an empty draft", () => {
    requestReload();
    stashDraftForReload("new", "   ");
    expect(takeReloadDraft("new")).toBeUndefined();
  });

  it("keeps the drafts of several composers apart", () => {
    requestReload();
    stashDraftForReload("new", "a");
    stashDraftForReload("t9", "b");
    expect(takeReloadDraft("t9")).toBe("b");
    expect(takeReloadDraft("new")).toBe("a");
  });

  it("ignores a garbled stash", () => {
    sessionStorage.setItem("kobe.reload-drafts", "{not json");
    expect(takeReloadDraft("t1")).toBeUndefined();
    sessionStorage.setItem("kobe.reload-drafts", JSON.stringify({ t1: 5 }));
    expect(takeReloadDraft("t1")).toBeUndefined();
  });
});

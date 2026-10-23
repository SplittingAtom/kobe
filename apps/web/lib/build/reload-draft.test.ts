// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELOAD_DRAFT_TTL_MS,
  forgetReloadDrafts,
  isReloadRequested,
  requestReload,
  resetReloadRequest,
  stashDraftForReload,
  takeReloadDraft,
} from "./reload-draft";

/** KOBE-487 ac-4: the banner's Reload keeps the composer's draft for the reloaded page. */
afterEach(() => {
  vi.useRealTimers();
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
    sessionStorage.setItem("kobe.reload-drafts", JSON.stringify({ t1: "old shape" }));
    expect(takeReloadDraft("t1")).toBeUndefined();
    const drafts = { t1: 5 };
    sessionStorage.setItem("kobe.reload-drafts", JSON.stringify({ savedAt: Date.now(), drafts }));
    expect(takeReloadDraft("t1")).toBeUndefined();
  });

  it("expires after ten minutes, so a later sign-in on this tab never gets it", () => {
    vi.useFakeTimers();
    requestReload();
    stashDraftForReload("t1", "mine");
    vi.advanceTimersByTime(RELOAD_DRAFT_TTL_MS + 1);
    expect(takeReloadDraft("t1")).toBeUndefined();
    expect(sessionStorage.getItem("kobe.reload-drafts")).toBeNull();
  });

  it("is still there within the ten minutes", () => {
    vi.useFakeTimers();
    requestReload();
    stashDraftForReload("t1", "mine");
    vi.advanceTimersByTime(RELOAD_DRAFT_TTL_MS - 1);
    expect(takeReloadDraft("t1")).toBe("mine");
  });

  it("is dropped on sign-out", () => {
    requestReload();
    stashDraftForReload("t1", "mine");
    forgetReloadDrafts();
    expect(takeReloadDraft("t1")).toBeUndefined();
  });
});

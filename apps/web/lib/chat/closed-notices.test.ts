// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSED_NOTICES_MAX, closeNotice, isNoticeClosed } from "./closed-notices";

/** KOBE-468 ac-2: a closed notice stays closed in this browser; blocked storage never throws. */
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("closed notices", () => {
  it("remembers each closed notice by its id", () => {
    closeNotice("run-1:4");
    closeNotice("run-1:7");
    expect(isNoticeClosed("run-1:4")).toBe(true);
    expect(isNoticeClosed("run-1:7")).toBe(true);
    expect(isNoticeClosed("run-1:5")).toBe(false);
  });

  it("keeps only the most recent ids", () => {
    for (let i = 0; i <= CLOSED_NOTICES_MAX; i++) closeNotice(`n${i}`);
    expect(isNoticeClosed("n0")).toBe(false);
    expect(isNoticeClosed(`n${CLOSED_NOTICES_MAX}`)).toBe(true);
  });

  it("ignores garbled storage and storage that throws", () => {
    localStorage.setItem("kobe.chat.closedNotices", "{nope");
    expect(isNoticeClosed("x")).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(isNoticeClosed("x")).toBe(false);
    expect(() => closeNotice("x")).not.toThrow();
  });
});

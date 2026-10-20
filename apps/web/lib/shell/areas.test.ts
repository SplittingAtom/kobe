// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AREAS, areaFromUrl, onChatPage } from "./areas";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("older ?area= addresses (KOBE-424, sent on to panels by KOBE-452)", () => {
  it("names the four pages that opened beside the thread, and no other", () => {
    expect(areaFromUrl("?area=memory&thread=x")).toBe("memory");
    expect(AREAS.memory.href).toBe("/me/memory");
    expect(areaFromUrl("?area=connectors")).toBe("connectors");
    expect(areaFromUrl("?area=skills")).toBeUndefined();
    expect(areaFromUrl("?area=__proto__")).toBeUndefined();
  });

  it("the chat page is the root address only", () => {
    expect(onChatPage()).toBe(true);
    window.history.replaceState(null, "", "/admin/team");
    expect(onChatPage()).toBe(false);
  });
});

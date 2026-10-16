// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => vi.unstubAllGlobals());

function stubClipboard(write?: (items: unknown[]) => Promise<void>) {
  const writeText = vi.fn(async (_t: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText, ...(write ? { write } : {}) } });
  return writeText;
}

describe("copyText (KOBE-292)", () => {
  it("writes text at hand at once", async () => {
    const writeText = stubClipboard();
    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("hands pending text over as a promised clipboard item where supported", async () => {
    const seen: unknown[] = [];
    const write = vi.fn(async (items: unknown[]) => {
      seen.push(...items);
    });
    const writeText = stubClipboard(write);
    class FakeItem {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    await copyText(Promise.resolve("later"));
    expect(writeText).not.toHaveBeenCalled();
    const blob = await (seen[0] as FakeItem).data["text/plain"];
    expect(await blob?.text()).toBe("later");
  });

  it("falls back to writing the text once it arrives", async () => {
    const writeText = stubClipboard(async () => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("ClipboardItem", function ClipboardItem() {});
    await copyText(Promise.resolve("later"));
    expect(writeText).toHaveBeenCalledWith("later");
  });

  it("fails without a clipboard, and when the text never comes", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyText("x")).rejects.toThrow(/clipboard/);
    stubClipboard();
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(copyText(Promise.reject(new Error("read failed")))).rejects.toThrow("read failed");
  });
});

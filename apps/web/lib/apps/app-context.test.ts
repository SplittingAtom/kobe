import { APP_CONTEXT_PREAMBLE } from "@kobe/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AppContextStore,
  ComposerInsertChannel,
  appContextBody,
  chipSummary,
  insertAt,
  splitAppContext,
  type AppContextChip,
} from "./app-context";

const chip = (appId: string, data: AppContextChip["data"]): AppContextChip => ({
  appId,
  connectorId: "c1",
  templateSha256: "e".repeat(64),
  title: "Lakehouse Explorer",
  data,
});

describe("context chips (KOBE-439 ac-2, ac-4)", () => {
  it("keeps the last context per app per draft, removes and clears", () => {
    const store = new AppContextStore();
    const seen = vi.fn();
    store.subscribe(seen);
    expect(store.set("t1", chip("a", { structuredContent: { table: "x" } }))).toBe(true);
    expect(store.set("t1", chip("a", { structuredContent: { table: "y" } }))).toBe(true);
    store.set("t1", chip("b", { content: [{ type: "text", text: "b" }] }));
    expect(store.forDraft("t1").map((c) => c.data)).toEqual([
      { structuredContent: { table: "y" } },
      { content: [{ type: "text", text: "b" }] },
    ]);
    expect(store.forDraft("t2")).toEqual([]);
    store.remove("t1", "a");
    expect(store.forDraft("t1").map((c) => c.appId)).toEqual(["b"]);
    store.clear("t1");
    expect(store.forDraft("t1")).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(5);
  });

  it("refuses a context over 8 KiB", () => {
    const store = new AppContextStore();
    expect(store.set("t", chip("a", { structuredContent: { x: "y".repeat(9 * 1024) } }))).toBe(
      false,
    );
    expect(store.forDraft("t")).toEqual([]);
  });

  it("sends exactly what the chips show", () => {
    expect(appContextBody([chip("a", { structuredContent: { t: 1 } })])).toEqual([
      {
        connector_id: "c1",
        app_id: "a",
        template_sha256: "e".repeat(64),
        data: { structuredContent: { t: 1 } },
      },
    ]);
    expect(
      chipSummary(chip("a", { content: [{ type: "text", text: "Table  c.n.t\nselected" }] })),
    ).toBe("Table c.n.t selected");
  });
});

describe("ui/message into the composer (ac-1)", () => {
  it("goes to the latest composer only, capped at 4 KiB; never sent", () => {
    const channel = new ComposerInsertChannel();
    expect(channel.request("hi")).toBe(false);
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    channel.listen(first);
    const stop = channel.listen(second);
    expect(channel.request("Use table `c.n.t`")).toBe(true);
    expect(second).toHaveBeenCalledWith("Use table `c.n.t`");
    expect(first).not.toHaveBeenCalled();
    expect(channel.request("é".repeat(2049))).toBe(false);
    stop();
    expect(channel.request("x")).toBe(true);
    expect(first).toHaveBeenCalledWith("x");
  });

  it("inserts at the caret", () => {
    expect(insertAt("ab", 1, "X")).toEqual({ text: "aXb", caret: 2 });
    expect(insertAt("ab", 99, "X")).toEqual({ text: "abX", caret: 3 });
  });
});

describe("sent context in history (ac-3)", () => {
  it("finds the server's fenced blocks before the member's text", () => {
    const text =
      `${APP_CONTEXT_PREAMBLE}\n` +
      '<app-context source="connector:Catalyst" untrusted="true">\n{\n  "t": 1\n}\n</app-context>\n' +
      '<app-context source="connector:Other" untrusted="true">\n{}\n</app-context>\n\nUse it';
    expect(splitAppContext(text)).toEqual({
      contexts: [
        { source: "Catalyst", json: '{\n  "t": 1\n}' },
        { source: "Other", json: "{}" },
      ],
      rest: "Use it",
    });
    expect(splitAppContext("plain")).toEqual({ contexts: [], rest: "plain" });
    expect(splitAppContext(`${APP_CONTEXT_PREAMBLE}\nno block`).contexts).toEqual([]);
  });
});

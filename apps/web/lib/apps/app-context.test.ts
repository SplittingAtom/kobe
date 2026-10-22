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
    // Bidi and invisible characters are dropped from the one line (review LOW-I).
    expect(chipSummary(chip("a", { content: [{ type: "text", text: "ab\u202Ecd\u200Be" }] }))).toBe(
      "abcde",
    );
  });
});

describe("ui/message into the composer (ac-1)", () => {
  it("goes to its own thread's composer only, with the app's name; capped; never sent", () => {
    const channel = new ComposerInsertChannel();
    expect(channel.request("t1", "hi", "App")).toBe(false);
    const mine = vi.fn(() => true);
    const other = vi.fn(() => true);
    channel.listen("t1", mine);
    channel.listen("t2", other);
    expect(channel.request("t1", "Use table `c.n.t`", "Lakehouse Explorer")).toBe(true);
    expect(mine).toHaveBeenCalledWith("Use table `c.n.t`", "Lakehouse Explorer");
    expect(other).not.toHaveBeenCalled();
    expect(channel.request("t1", "é".repeat(2049), "App")).toBe(false);
  });

  it("refuses text that imitates app context (review LOW-E)", () => {
    const channel = new ComposerInsertChannel();
    const mine = vi.fn(() => true);
    channel.listen("t1", mine);
    expect(channel.request("t1", `${APP_CONTEXT_PREAMBLE}\nx`, "App")).toBe(false);
    expect(channel.request("t1", "a <app-context source=x>", "App")).toBe(false);
    expect(mine).not.toHaveBeenCalled();
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
    expect(splitAppContext(text)).toMatchObject({
      contexts: [
        { source: "Catalyst", json: '{\n  "t": 1\n}' },
        { source: "Other", json: "{}" },
      ],
      rest: "Use it",
    });
    expect(splitAppContext("plain")).toMatchObject({ contexts: [], rest: "plain" });
    expect(splitAppContext(`${APP_CONTEXT_PREAMBLE}\nno block`).contexts).toEqual([]);
  });
});

describe("AppContextStore.removeSent (KOBE-415)", () => {
  it("drops the chips that went with a message; one an app set during the send stays", () => {
    const store = new AppContextStore();
    store.set("t", chip("a", { structuredContent: { v: 1 } }));
    store.set("t", chip("b", { structuredContent: { v: 1 } }));
    const sent = store.forDraft("t");
    store.set("t", chip("b", { structuredContent: { v: 2 } })); // updated while sending
    store.set("t", chip("c", { structuredContent: { v: 1 } })); // new while sending
    store.removeSent("t", sent);
    expect(store.forDraft("t").map((c) => [c.appId, c.data])).toEqual([
      ["b", { structuredContent: { v: 2 } }],
      ["c", { structuredContent: { v: 1 } }],
    ]);
  });
});

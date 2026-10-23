import { describe, expect, it, vi } from "vitest";
import { AppItemStore, appItemsOf, kindLabel, referencesBody, type AppItem } from "./app-items";

const link = (over: Record<string, unknown> = {}) => ({
  type: "resource_link",
  uri: "catalyst://lakehouse/cat/ns/orders",
  name: "cat.ns.orders",
  _meta: { "io.kobe/item-kind": "table" },
  ...over,
});

const FROM = "Lakehouse Picker";

describe("appItemsOf (KOBE-490 ac-1)", () => {
  it("takes valid resource_links with their kind, title and app", () => {
    const { items, dropped } = appItemsOf([
      { type: "text", text: "`cat.ns.orders`" },
      link({ title: "Orders\u202e table" }),
    ]);
    expect(dropped).toBe(0);
    expect(items).toEqual([
      {
        uri: "catalyst://lakehouse/cat/ns/orders",
        name: "cat.ns.orders",
        kind: "table",
        title: "Orders table",
      },
    ]);
  });

  it("makes unknown or missing kinds generic", () => {
    const { items } = appItemsOf([
      link({ uri: "a://1", _meta: { "io.kobe/item-kind": "Weird Kind" } }),
      link({ uri: "a://2", _meta: undefined }),
      link({ uri: "a://3", _meta: { "io.kobe/item-kind": 7 } }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["item", "item", "item"]);
  });

  it("drops invalid blocks: script-like schemes, bad uris, names and titles", () => {
    const bad = [
      link({ uri: "javascript:alert(1)" }),
      link({ uri: "JavaScript:alert(1)" }),
      link({ uri: "data:text/html,x" }),
      link({ uri: "vbscript:x" }),
      link({ uri: "no-scheme" }),
      link({ uri: "a://has space" }),
      link({ uri: `a://${"x".repeat(2048)}` }),
      link({ name: "" }),
      link({ name: "a`b" }),
      link({ name: "a\nb" }),
      link({ name: "x".repeat(513) }),
      link({ title: "t".repeat(513) }),
      link({ uri: 5 }),
    ];
    const { items, dropped } = appItemsOf(bad);
    expect(items).toEqual([]);
    expect(dropped).toBe(bad.length);
  });

  it("de-duplicates by uri and keeps at most 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => link({ uri: `a://${i}`, name: `n${i}` }));
    const { items, dropped } = appItemsOf([link(), link(), ...many]);
    expect(items).toHaveLength(20);
    expect(dropped).toBe(27 - 20);
  });

  it("accepts any app's scheme", () => {
    expect(appItemsOf([link({ uri: "https://example.com/x" })]).items).toHaveLength(1);
    expect(appItemsOf([link({ uri: "notion://page/abc" })]).items).toHaveLength(1);
  });
});

const item = (uri: string, kind = "table"): AppItem => ({ uri, name: uri, kind, from: FROM });

describe("AppItemStore (KOBE-490)", () => {
  it("adds per draft, de-duplicated by uri, and notifies", () => {
    const store = new AppItemStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.add("t1", [item("a"), item("b")]);
    store.add("t1", [item("a"), item("c")]);
    store.add("t2", [item("a")]);
    expect(store.forDraft("t1").map((i) => i.uri)).toEqual(["a", "b", "c"]);
    expect(store.forDraft("t2").map((i) => i.uri)).toEqual(["a"]);
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("keeps snapshots stable and makes new ones on change", () => {
    const store = new AppItemStore();
    const empty = store.snapshot("t");
    expect(store.snapshot("t")).toBe(empty);
    store.add("t", [item("a")]);
    const one = store.snapshot("t");
    expect(one).not.toBe(empty);
    expect(store.snapshot("t")).toBe(one);
  });

  it("removes one, removes what was sent (not what came meanwhile), clears and moves", () => {
    const store = new AppItemStore();
    store.add("t", [item("a"), item("b")]);
    store.remove("t", "a");
    expect(store.forDraft("t").map((i) => i.uri)).toEqual(["b"]);
    const sent = store.forDraft("t");
    store.add("t", [item("c")]);
    store.removeSent("t", sent);
    expect(store.forDraft("t").map((i) => i.uri)).toEqual(["c"]);
    store.move("t", "u");
    expect(store.forDraft("t")).toEqual([]);
    expect(store.forDraft("u").map((i) => i.uri)).toEqual(["c"]);
    store.clear("u");
    expect(store.forDraft("u")).toEqual([]);
  });

  it("refuses more than 20 chips in a draft", () => {
    const store = new AppItemStore();
    store.add(
      "t",
      Array.from({ length: 20 }, (_, i) => item(`u${i}`)),
    );
    expect(store.add("t", [item("x")])).toBe(false);
    expect(store.forDraft("t")).toHaveLength(20);
  });

  it("shows a note when an app sent nothing usable; the next change clears it", () => {
    const store = new AppItemStore();
    store.refused("t", FROM);
    expect(store.snapshot("t").note).toBe("Lakehouse Picker sent items Kobe could not use.");
    store.add("t", [item("a")]);
    expect(store.snapshot("t").note).toBeUndefined();
  });
});

describe("referencesBody and kindLabel", () => {
  it("sends names and kinds only, unique", () => {
    expect(referencesBody([item("a"), { ...item("a2"), name: "a" }, item("b", "view")])).toEqual([
      { name: "a", kind: "table" },
      { name: "b", kind: "view" },
    ]);
  });

  it("labels kinds", () => {
    expect(kindLabel("table")).toBe("Table");
    expect(kindLabel("item")).toBe("Item");
  });
});

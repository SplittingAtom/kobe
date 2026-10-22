import { mentionMarker } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { MentionStore } from "./mentions";

describe("MentionStore.settleSent (KOBE-415)", () => {
  it("drops the picks that went, keeps those added during the send or still in the text", () => {
    const store = new MentionStore();
    store.add("t", "a.csv");
    store.add("t", "b.csv");
    store.add("t", "c.csv"); // picked while the message was being sent
    store.settleSent("t", ["a.csv", "b.csv"], `and ${mentionMarker("b.csv")} again`);
    expect([...store.get("t")].sort()).toEqual(["b.csv", "c.csv"]);
    store.settleSent("t", ["b.csv", "c.csv"], "");
    expect(store.get("t").size).toBe(0);
  });
});

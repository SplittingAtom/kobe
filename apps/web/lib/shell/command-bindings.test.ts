import { describe, expect, it, vi } from "vitest";
import { bindingsSignature, createCommandBindings, relayBindings } from "./command-bindings";
import type { MenuBindings } from "./menu";

describe("createCommandBindings", () => {
  it("merges each source's bindings; the later-mounted source wins for the same command", () => {
    const store = createCommandBindings();
    const a = Symbol("a");
    const b = Symbol("b");
    const first = vi.fn();
    const second = vi.fn();
    store.set(a, { stop: { onSelect: first }, "compact-thread": { onSelect: first } });
    store.set(b, { stop: { onSelect: second } });
    expect(store.get().stop?.onSelect).toBe(second);
    expect(store.get()["compact-thread"]?.onSelect).toBe(first);
  });

  it("drops a source's bindings when it goes, and notifies on each change", () => {
    const store = createCommandBindings();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    const a = Symbol("a");
    store.set(a, { stop: { onSelect: () => {} } });
    const before = store.get();
    store.remove(a);
    expect(store.get()).toEqual({});
    expect(store.get()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    store.set(a, {});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the same snapshot until something changes", () => {
    const store = createCommandBindings();
    expect(store.get()).toBe(store.get());
  });

  it("tracks whether a listing (the / menu, the palette) wants lazy choices loaded", () => {
    const store = createCommandBindings();
    const listener = vi.fn();
    store.subscribeWanted(listener);
    expect(store.wanted()).toBe(false);
    store.setWanted(true);
    store.setWanted(true);
    expect(store.wanted()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("bindingsSignature and relayBindings", () => {
  it("the signature ignores fresh handlers and changes with what a listing shows", () => {
    const a = bindingsSignature({ stop: { onSelect: () => {}, blocker: null } });
    expect(bindingsSignature({ stop: { onSelect: () => {}, blocker: null } })).toBe(a);
    expect(bindingsSignature({ stop: { onSelect: () => {}, blocker: "No." } })).not.toBe(a);
    const choice = (label: string) => ({
      "move-thread": { choices: [{ key: "p", label, onSelect: () => {} }] },
    });
    expect(bindingsSignature(choice("Q4"))).not.toBe(bindingsSignature(choice("Q5")));
  });

  it("relayed handlers call the latest bindings' handlers", () => {
    const first = vi.fn();
    const later = vi.fn();
    const pick = vi.fn();
    let latest: MenuBindings = {
      stop: { onSelect: first },
      "move-thread": { choices: [{ key: "p", label: "Q4", onSelect: first }] },
    };
    const relayed = relayBindings(latest, () => latest);
    latest = {
      stop: { onSelect: later },
      "move-thread": { choices: [{ key: "p", label: "Q4", onSelect: pick }] },
    };
    relayed.stop?.onSelect?.();
    relayed["move-thread"]?.choices?.[0]?.onSelect();
    expect(first).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
  });
});

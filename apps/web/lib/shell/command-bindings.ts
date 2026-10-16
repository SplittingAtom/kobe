/**
 * The live command bindings (KOBE-224): what each registry command does right now, published by
 * the component that owns it (`useBindCommands`) and read by every listing of actions: the `/`
 * menu, and the palette and shortcuts of KOBE-225. One binding per command: when two sources bind
 * the same command, the one mounted later wins (a source keeps its place when it republishes).
 */
import type { MenuBinding, MenuBindings, MenuChoice } from "./menu";

export interface CommandBindingsStore {
  /** Replaces what `source` binds (keeping its place in mount order). */
  set(source: symbol, bindings: MenuBindings): void;
  remove(source: symbol): void;
  /** All sources merged; the same object until something changes. */
  get(): MenuBindings;
  subscribe(listener: () => void): () => void;
  /**
   * A listing is open, so bindings whose choices are read lazily (Move's projects) should load
   * them now; a row menu loads them when it opens instead.
   */
  wanted(): boolean;
  setWanted(wanted: boolean): void;
  subscribeWanted(listener: () => void): () => void;
}

function listeners() {
  let set: ReadonlySet<() => void> = new Set();
  return {
    add(listener: () => void) {
      set = new Set([...set, listener]);
      return () => {
        set = new Set([...set].filter((l) => l !== listener));
      };
    },
    emit() {
      for (const l of set) l();
    },
  };
}

export function createCommandBindings(): CommandBindingsStore {
  let sources: ReadonlyMap<symbol, MenuBindings> = new Map();
  let merged: MenuBindings = {};
  let wanted = false;
  const changes = listeners();
  const wants = listeners();
  const update = (next: ReadonlyMap<symbol, MenuBindings>) => {
    sources = next;
    merged = Object.assign({}, ...sources.values()) as MenuBindings;
    changes.emit();
  };
  return {
    set: (source, bindings) => update(new Map([...sources, [source, bindings]])),
    remove: (source) => {
      if (sources.has(source)) update(new Map([...sources].filter(([k]) => k !== source)));
    },
    get: () => merged,
    subscribe: changes.add,
    wanted: () => wanted,
    setWanted: (next) => {
      if (next === wanted) return;
      wanted = next;
      wants.emit();
    },
    subscribeWanted: wants.add,
  };
}

/**
 * What a listing shows of `bindings`: ids, labels, blockers and choices, not the handlers. A
 * publisher republishes only when this changes, so a listing keeps its items (and highlight)
 * while the publisher re-renders, for example on every streamed event.
 */
export function bindingsSignature(bindings: MenuBindings): string {
  return JSON.stringify(
    Object.entries(bindings).map(([id, b]) => [
      id,
      b?.label ?? null,
      b?.blocker ?? null,
      b?.onSelect !== undefined,
      b?.destructive === true,
      b?.choices?.map((c) => [c.key, c.label, c.current === true]) ?? null,
    ]),
  );
}

/**
 * `bindings` with handlers that call whatever `latest()` binds at the time of the call, so a
 * published (and kept) binding always runs the button's current handler.
 */
export function relayBindings(bindings: MenuBindings, latest: () => MenuBindings): MenuBindings {
  const relay = (id: string, b: MenuBinding): MenuBinding => {
    const now = () => (latest() as Readonly<Record<string, MenuBinding | undefined>>)[id];
    const choice = (c: MenuChoice): MenuChoice => ({
      ...c,
      onSelect: () =>
        now()
          ?.choices?.find((x) => x.key === c.key)
          ?.onSelect(),
    });
    return {
      ...b,
      ...(b.onSelect ? { onSelect: () => now()?.onSelect?.() } : {}),
      ...(b.choices ? { choices: b.choices.map(choice) } : {}),
    };
  };
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([id, b]) => (b ? [[id, relay(id, b)]] : [])),
  );
}

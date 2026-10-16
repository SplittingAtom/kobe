/**
 * The live command bindings (KOBE-224): what each registry command does right now, published by
 * the component that owns it (`useBindCommands`) and read by every listing of actions: the `/`
 * menu, and the palette and shortcuts of KOBE-225. One binding per command; a later source wins.
 */
import type { MenuBindings } from "./menu";

export interface CommandBindingsStore {
  /** Replaces what `source` binds. */
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

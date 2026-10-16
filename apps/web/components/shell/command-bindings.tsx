"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  bindingsSignature,
  createCommandBindings,
  relayBindings,
  type CommandBindingsStore,
} from "../../lib/shell/command-bindings";
import type { MenuBindings } from "../../lib/shell/menu";

/**
 * The chat's live command bindings (KOBE-224, `lib/shell/command-bindings.ts`). Without a provider
 * (the builder's test pane) publishing does nothing and listings are empty.
 */
const Bindings = createContext<CommandBindingsStore | null>(null);

export function CommandBindingsProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createCommandBindings);
  return <Bindings.Provider value={store}>{children}</Bindings.Provider>;
}

/**
 * Publishes what the caller's own buttons do (the same handlers), while it is mounted. Pass the
 * bindings the buttons use, so a listing runs exactly what a click runs. Republished only when
 * what a listing shows changes (`bindingsSignature`); the handlers always call the latest render's.
 */
export function useBindCommands(bindings: MenuBindings): void {
  const store = useContext(Bindings);
  const [source] = useState(() => Symbol("command bindings"));
  const latest = useRef(bindings);
  useEffect(() => {
    latest.current = bindings;
  });
  const signature = bindingsSignature(bindings);
  useEffect(() => {
    store?.set(
      source,
      relayBindings(latest.current, () => latest.current),
    );
  }, [store, source, signature]);
  useEffect(() => () => store?.remove(source), [store, source]);
}

const NONE: MenuBindings = {};
const noSubscribe = () => () => {};
const none = () => NONE;
const no = () => false;

/** Every live binding (merged). */
export function useBoundCommands(): MenuBindings {
  const store = useContext(Bindings);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.get ?? none,
    store?.get ?? none,
  );
}

/** Whether a listing is open (load lazy choices now). */
export function useCommandsWanted(): boolean {
  const store = useContext(Bindings);
  return useSyncExternalStore(
    store?.subscribeWanted ?? noSubscribe,
    store?.wanted ?? no,
    store?.wanted ?? no,
  );
}

/** A listing says it is open (true) or closed (false). */
export function useWantCommands(open: boolean): void {
  const store = useContext(Bindings);
  useEffect(() => {
    if (!open || !store) return;
    store.setWanted(true);
    return () => store.setWanted(false);
  }, [store, open]);
}

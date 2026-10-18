"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Places in the utility bar that the thread workspace fills (KOBE-197). The bar renders before a
 * team is active and stays mounted across team switches; the workspace, which owns the
 * assistant-ui runtime, portals its bar parts into these targets so they keep its context.
 */
export type ShellSlotName = "search" | "nav";

type Targets = Readonly<Record<ShellSlotName, HTMLElement | null>>;

type Register = (name: ShellSlotName, el: HTMLElement | null) => void;

// Two contexts: the targets change as they mount, the (stable) register never does, so a target's
// ref callback is not re-run by its own registration.
const TargetsContext = createContext<Targets | null>(null);
const RegisterContext = createContext<Register | null>(null);

/**
 * The one-row bar's menu (CE8, KOBE-201), open or not: the bar shows it, and the workspace closes
 * it when another thread opens (a search hit, a notification).
 */
export interface BarMenu {
  readonly open: boolean;
  setOpen(open: boolean): void;
}

const BarMenuContext = createContext<BarMenu>({ open: false, setOpen: () => {} });

export function useBarMenu(): BarMenu {
  return useContext(BarMenuContext);
}

export function ShellSlotsProvider({ children }: { readonly children: ReactNode }) {
  const [targets, setTargets] = useState<Targets>({ search: null, nav: null });
  const register = useCallback<Register>((name, el) => {
    setTargets((t) => (t[name] === el ? t : { ...t, [name]: el }));
  }, []);
  const [open, setOpen] = useState(false);
  const menu = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <RegisterContext.Provider value={register}>
      <BarMenuContext.Provider value={menu}>
        <TargetsContext.Provider value={targets}>{children}</TargetsContext.Provider>
      </BarMenuContext.Provider>
    </RegisterContext.Provider>
  );
}

/** Where a slot's content lands: an empty element until the workspace fills it. */
export function ShellSlotTarget({
  name,
  ...rest
}: { readonly name: ShellSlotName } & HTMLAttributes<HTMLDivElement>) {
  const register = useContext(RegisterContext);
  const ref = useCallback((el: HTMLDivElement | null) => register?.(name, el), [register, name]);
  return <div ref={ref} {...rest} />;
}

/** Renders `children` into the named bar slot (nothing outside a shell or before it mounts). */
export function ShellSlot({
  name,
  children,
}: {
  readonly name: ShellSlotName;
  readonly children: ReactNode;
}) {
  const target = useContext(TargetsContext)?.[name] ?? null;
  return target === null ? null : createPortal(children, target);
}

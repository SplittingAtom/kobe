"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BAND_QUERIES, bandFromMatches, type ShellBand } from "../../lib/shell/layout";

/**
 * The window's CE7 band (KOBE-201), shared by the bar, the rail and the artifact column so they
 * switch together. `wide` on the server and on the first client render (the markup matches), then
 * read from `matchMedia` and followed as the window resizes. Outside a provider (the agent
 * builder's test pane, components rendered alone) it is always `wide`.
 */
const BandContext = createContext<ShellBand>("wide");

export function useShellBand(): ShellBand {
  return useContext(BandContext);
}

export function ShellBandProvider({ children }: { readonly children: ReactNode }) {
  const [band, setBand] = useState<ShellBand>("wide");
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    // One list per edge, created once; each says when the window crosses it.
    const lists = {
      wide: window.matchMedia(BAND_QUERIES.wide),
      medium: window.matchMedia(BAND_QUERIES.medium),
      overlay: window.matchMedia(BAND_QUERIES.overlay),
    };
    const update = () =>
      setBand(
        bandFromMatches({
          wide: lists.wide.matches,
          medium: lists.medium.matches,
          overlay: lists.overlay.matches,
        }),
      );
    update();
    const all = Object.values(lists).filter((l) => typeof l.addEventListener === "function");
    for (const l of all) l.addEventListener("change", update);
    // Also on resize, reading the same lists: some engines miss a `change` (happy-dom does when
    // the window jumps across all three edges at once), and a test fake may have no listeners.
    window.addEventListener("resize", update);
    return () => {
      for (const l of all) l.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return <BandContext.Provider value={band}>{children}</BandContext.Provider>;
}

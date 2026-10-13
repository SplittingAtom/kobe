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

function readBand(): ShellBand {
  if (typeof window.matchMedia !== "function") return "wide";
  const matches = (query: string) => window.matchMedia(query).matches;
  return bandFromMatches({
    wide: matches(BAND_QUERIES.wide),
    medium: matches(BAND_QUERIES.medium),
    overlay: matches(BAND_QUERIES.overlay),
  });
}

export function ShellBandProvider({ children }: { readonly children: ReactNode }) {
  const [band, setBand] = useState<ShellBand>("wide");
  useEffect(() => {
    // Every band change is a resize (rotation and zoom included); setState skips equal bands.
    const update = () => setBand(readBand());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return <BandContext.Provider value={band}>{children}</BandContext.Provider>;
}

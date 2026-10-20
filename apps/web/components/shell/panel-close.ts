"use client";

import { createContext, useContext } from "react";

/**
 * Closes the panel over the workspace this is in (KOBE-452), through its unsaved-edit question;
 * null outside a panel. The way back to the chat inside a panel ("Back to Kobe") uses it instead
 * of a link that would add a history entry.
 */
export const PanelCloseContext = createContext<(() => void) | null>(null);

export function usePanelClose(): (() => void) | null {
  return useContext(PanelCloseContext);
}

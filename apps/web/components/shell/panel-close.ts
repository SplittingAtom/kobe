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

/**
 * Opens a panel over the workspace at its address (KOBE-453: the Threads panel from the rail), on
 * the workspace's router; null outside the workspace.
 */
export const OpenPanelContext = createContext<((href: string) => void) | null>(null);

export function useOpenPanel(): ((href: string) => void) | null {
  return useContext(OpenPanelContext);
}

"use client";

import { IconActionProvider } from "../shell/icon-action";
import { ThemeToggle } from "../shell/theme-toggle";

/** The chat bar's icon button, without the chat's preflight: resets the browser's button look. */
const TOGGLE =
  "m-0 box-border inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent p-0 text-console-muted hover:bg-console-panel hover:text-console-fg [&_svg]:size-4";

/**
 * The chat bar's theme toggle (KOBE-282) in a console or My-area header. Its tooltip and button
 * use Tailwind utilities, which the console layouts load (app/admin/admin-global.css, KOBE-294);
 * its tooltip provider is its own, the consoles have no other IconActions.
 */
export function ConsoleThemeToggle() {
  return (
    <IconActionProvider>
      <ThemeToggle className={TOGGLE} />
    </IconActionProvider>
  );
}

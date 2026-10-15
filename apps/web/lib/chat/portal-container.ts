/**
 * Where the chat's portals (tooltips, dialogs) mount. The shadcn tokens and the preflight slice are
 * scoped to the chat root (`[data-kobe-chat]`, app/chat-global.css), so content portalled under
 * <body> would resolve its colours to undefined variables and ignore the dark theme. `.app` keeps
 * the window as the containing block of fixed descendants, so overlays still cover the viewport.
 */
export function chatPortalContainer(): HTMLElement | undefined {
  // Rendered on the server too (the bar's icon links, KOBE-197): no document there.
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLElement>("[data-kobe-chat]") ?? undefined;
}

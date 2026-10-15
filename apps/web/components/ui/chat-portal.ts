/**
 * Marks content portalled out of a drawer or sheet (Radix popovers, tooltips, and the chat's
 * dialogs with `data-kobe-portal`): a press or Escape there is not "outside" the layer
 * (use-modal-layer.ts).
 */
export const CHAT_PORTALLED = "[data-radix-popper-content-wrapper], [data-kobe-portal]";

/**
 * Where the chat's portals (tooltips, dialogs, menus) mount. The colour tokens are on `:root`
 * (app/theme.css, KOBE-282), but the preflight slice the shadcn components rely on (box-sizing,
 * border colour, form-control fonts) is scoped to the chat root (app/chat-global.css), and the
 * chat's modal layers (use-modal-layer.ts) treat the chat root as their scope. `.app` keeps the
 * window as the containing block of fixed descendants, so overlays still cover the viewport.
 */
export function chatPortalContainer(): HTMLElement | undefined {
  // Rendered on the server too (the bar's icon links, KOBE-197): no document there.
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLElement>("[data-kobe-chat]") ?? undefined;
}

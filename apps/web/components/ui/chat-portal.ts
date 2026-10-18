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
 * A shared popup (the theme toggle's tooltip) on a console or My-area page, which has no chat
 * root, mounts in the console root instead (KOBE-294).
 */
export function chatPortalContainer(): HTMLElement | undefined {
  // Rendered on the server too (the bar's icon links, KOBE-197): no document there.
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLElement>("[data-kobe-chat]") ?? consolePortalContainer();
}

/**
 * Where the consoles' portals (confirm dialogs, KOBE-294) mount: the console root
 * (`[data-kobe-console]`, the console and My-area shells), so they take the console's font and
 * colours and its scoped rules (app/admin/admin-global.css). The tokens are on `:root`, so both
 * themes resolve there; the shell has no transform, so fixed overlays still cover the viewport.
 */
export function consolePortalContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  return (
    document.querySelector<HTMLElement>(`[${CONSOLE_PORTAL}]`) ??
    document.querySelector<HTMLElement>("[data-kobe-console]") ??
    undefined
  );
}

/**
 * A console root at the document's top for the portals of a My area page beside the thread
 * (CE4, KOBE-424): outside the chat root and its stacking contexts (the column, its sheet), so a
 * confirm dialog covers the whole window, bar included, with the console's scoped rules. Marked
 * as portalled content for the chat's modal layers (`CHAT_PORTALLED`). Created once, kept.
 */
export const CONSOLE_PORTAL = "data-kobe-console-portal";

export function ensureConsolePortal(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  const found = document.querySelector<HTMLElement>(`[${CONSOLE_PORTAL}]`);
  if (found) return found;
  const root = document.createElement("div");
  root.setAttribute("data-kobe-console", "");
  root.setAttribute(CONSOLE_PORTAL, "");
  root.setAttribute("data-kobe-portal", "");
  document.body.append(root);
  return root;
}

/**
 * The MCP Apps frame's sandbox attribute (spec T2), shared by the template preview (KOBE-434) and
 * MA-5's app frame. The CSP comes from Kobe's frame route as a response header (`sandbox
 * allow-scripts`, no network; spec MA4 as amended 2026-10-19), never from an injected meta tag
 * and never via `srcdoc` (which would inherit the page CSP).
 */

/** Scripts only: no same-origin (opaque origin), forms, popups, modals, downloads or navigation. */
export const APP_FRAME_SANDBOX = "allow-scripts";

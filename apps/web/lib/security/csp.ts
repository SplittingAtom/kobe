/**
 * Content Security Policy for the web app (coordinator security review of KOBE-32). Scripts run only
 * from this origin with the request's nonce (`'strict-dynamic'` lets Next's nonced bootstrap load
 * its chunks); no `'unsafe-eval'` outside `next dev` (React's dev tooling needs it). Styles: our
 * stylesheets and nonced `<style>`; `style-src-attr 'unsafe-inline'` allows only `style="…"`
 * attributes (layout libraries set heights that way; attributes can't run code or load anything).
 * Images: this origin and data URLs only (agent Markdown never loads images, `markdown.tsx`).
 * The API and event stream are same-origin (`connect-src 'self'`). Never framed.
 *
 * Not set: `upgrade-insecure-requests` (a plain-HTTP install would break its own requests).
 * KOBE-55 (artifacts in `srcdoc` iframes) revisits `frame-src`.
 */
export interface CspOptions {
  readonly dev: boolean;
}

export function buildCsp(nonce: string, { dev }: CspOptions): string {
  const directives: readonly (readonly string[])[] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", `'nonce-${nonce}'`],
    ["style-src-attr", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["media-src", "'self'"],
    ["frame-src", "'self'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/** 128 random bits, base64 (works on plain-HTTP origins and in the Edge/Node proxy runtime). */
export function newNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Headers for every response (`next.config.ts`); the CSP itself is per request (`proxy.ts`). */
export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
];

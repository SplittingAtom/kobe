/**
 * The only Bifrost paths a sandbox may reach (KOBE-22 review: "inference path only, no management
 * API"). Everything else — `/api/*` (admin), batches, files, MCP, the UI, `/health` — is 404.
 * Paths are matched literally (no percent-encoding, no dot segments), so nothing reaches Bifrost
 * that its router could read as another route.
 */
export type RouteKind = "openai" | "anthropic" | "gemini";

export interface Route {
  readonly kind: RouteKind;
  /** The path forwarded to Bifrost (identical to the request's). */
  readonly path: string;
  /** Gemini names the model in the path (`<provider>/<model>`). */
  readonly pathModel: string | undefined;
}

const GEMINI =
  /^\/genai\/v1beta\/models\/([A-Za-z0-9][A-Za-z0-9._/-]{0,200}):(generateContent|streamGenerateContent|countTokens)$/;

const EXACT: Readonly<Record<string, readonly [string, RouteKind]>> = {
  "/v1/chat/completions": ["POST", "openai"],
  "/v1/responses": ["POST", "openai"],
  "/v1/models": ["GET", "openai"],
  "/anthropic/v1/messages": ["POST", "anthropic"],
  "/anthropic/v1/messages/count_tokens": ["POST", "anthropic"],
};

export function classify(method: string, pathname: string): Route | undefined {
  if (pathname.includes("..") || pathname.includes("//")) return undefined;
  const exact = EXACT[pathname];
  if (exact) {
    return exact[0] === method
      ? { kind: exact[1], path: pathname, pathModel: undefined }
      : undefined;
  }
  const gemini = GEMINI.exec(pathname);
  if (gemini && method === "POST") {
    return { kind: "gemini", path: pathname, pathModel: gemini[1] };
  }
  return undefined;
}

/** Query parameters forwarded (Gemini streaming's `alt=sse`); `key` (a credential) never is. */
export function forwardedQuery(search: URLSearchParams): string {
  const alt = search.get("alt");
  return alt === "sse" ? "?alt=sse" : "";
}

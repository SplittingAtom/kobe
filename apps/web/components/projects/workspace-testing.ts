/**
 * Test helpers for the Workspace views (KOBE-581): projects and checkouts as the server answers
 * them (snake_case), behind a fetch that records every call.
 */
export const TEAM = "00000000-0000-4000-8000-0000000000aa";

export const wireProject = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `p-${slug}`,
  team_id: TEAM,
  slug,
  name: `${slug[0]?.toUpperCase() ?? ""}${slug.slice(1)} plan`,
  description: "",
  instructions: "",
  default_agent_id: null,
  visibility: "workspace",
  my_role: "editor",
  file_count: 1,
  head_commit_id: null,
  live_bytes: null,
  history_bytes: null,
  live_objects: null,
  history_objects: null,
  created_by: "u-1",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  archived_at: null,
  ...over,
});

export const wireCheckout = (slug: string, seq: number | null = 1) => ({
  project_id: `p-${slug}`,
  slug,
  base_commit_id: seq === null ? null : `c-${seq}`,
  base_commit_seq: seq,
  created_at: "2026-11-03T10:00:00Z",
  updated_at: "2026-11-03T10:00:00Z",
});

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Reply = readonly [number, unknown?];

/** A fetch answering "METHOD /path?query" routes (a list is used in turn, the last repeats). */
export function routedFetch(routes: Record<string, Reply | readonly Reply[]>) {
  const calls: Call[] = [];
  const served = new Map<string, number>();
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://kobe.test");
    const method = init.method ?? "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: `${url.pathname}${url.search}`, body });
    const route = routes[key];
    if (route === undefined) {
      return Response.json({ code: "not_found", message: `unrouted ${key}` }, { status: 404 });
    }
    const replies = (Array.isArray(route[0]) ? route : [route]) as readonly Reply[];
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    const [status, payload] = replies[Math.min(n, replies.length - 1)] ?? [500];
    return payload === undefined
      ? new Response(null, { status })
      : Response.json(payload, { status });
  };
  return { fetchFn, calls };
}

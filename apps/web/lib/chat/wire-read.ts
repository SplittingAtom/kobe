/**
 * One GET of a thread route read as sent (wire casing, no camelizing), validated with its
 * protocol schema: the lineage strip (TL1) and the Conversation tree's `branches` read (CT2).
 * Never throws: null for a non-2xx answer, a malformed body or a network failure.
 */
import type { z } from "zod";
import { TEAM_HEADER } from "../teams";

export async function readWire<S extends z.ZodType>(
  route: string,
  schema: S,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<z.infer<S> | null> {
  try {
    const res = await fetchFn(route, {
      method: "GET",
      headers: { accept: "application/json", [TEAM_HEADER]: teamId },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? (parsed.data as z.infer<S>) : null;
  } catch {
    return null;
  }
}

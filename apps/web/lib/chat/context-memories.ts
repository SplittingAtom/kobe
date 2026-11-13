/**
 * Memories in context (KOBE-382, U48): `GET /v1/threads/{id}/context/memories` lists the semantic
 * memories the thread's latest run was given, from the run's records. The context viewer shows
 * them per lane and Session info counts them; both only for the thread's owner (the route answers
 * 403 to a shared reader). Statements are untrusted text: render them as plain text only.
 */
import {
  CONTEXT_MEMORY_SECTION_LABELS,
  threadContextMemoriesSchema,
  type ThreadContextMemories,
  type ThreadContextMemoryItem,
} from "@kobe/protocol";
import { readWire } from "./wire-read";

/** One read, validated as sent. Never throws: null on failure (a reader gets 403 → null). */
export function readThreadContextMemories(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ThreadContextMemories | null> {
  const route = `/v1/threads/${encodeURIComponent(threadId)}/context/memories`;
  return readWire(route, threadContextMemoriesSchema, teamId, fetchFn);
}

export interface MemoryLane {
  readonly lane: ThreadContextMemoryItem["lane"];
  readonly label: string;
  readonly items: readonly ThreadContextMemoryItem[];
}

const ORDER: readonly ThreadContextMemoryItem["lane"][] = [
  "policy",
  "site",
  "team",
  "portable",
  "user",
];

/** The items per lane, in the order the block renders them; empty lanes are left out. */
export function memoryLanes(items: readonly ThreadContextMemoryItem[]): MemoryLane[] {
  return ORDER.map((lane) => ({
    lane,
    label: CONTEXT_MEMORY_SECTION_LABELS[lane],
    items: items.filter((i) => i.lane === lane),
  })).filter((l) => l.items.length > 0);
}

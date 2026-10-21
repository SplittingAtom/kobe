import { threadContextResultSchema, type ThreadContextResult } from "@kobe/protocol";
import { sealedReplyKeyPair } from "@kobe/protocol/node";
import { expect } from "vitest";
import type { FakeServer } from "./fake-server.js";

/**
 * Asks the agent for a thread's context the way the server does (KOBE-470): with a one-use reply
 * key, opening the sealed answer. Fails the test on anything but a sealed, valid answer.
 */
export async function readThreadContext(
  server: FakeServer,
  threadId: string,
  maxBytes = 1_000_000,
  timeoutMs?: number,
): Promise<ThreadContextResult> {
  const pair = sealedReplyKeyPair();
  const result = await server.command(
    { type: "thread.context", thread_id: threadId, max_bytes: maxBytes, reply_key: pair.key },
    timeoutMs,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const data = (result as { data?: { sealed?: unknown } }).data;
  const opened = pair.open(data?.sealed, threadId);
  if (opened === undefined) throw new Error("the answer was not sealed to the reply key");
  return threadContextResultSchema.parse(JSON.parse(opened));
}

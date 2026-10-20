import { TEAM_HEADER } from "../teams";
import type { ToolCallAnswer, ToolListAnswer } from "./host-bridge";

/**
 * The host bridge's calls to Kobe (KOBE-437): the MA-4 endpoints under the member's session and
 * active team. Not `apiRequest`: that one camelizes keys, which would change an upstream tool's
 * result before the app sees it. Same-origin paths only; nothing here ever leaves Kobe.
 */
const APP_ID = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_MAX = 300;

type Failure = { readonly ok: false; readonly code: string; readonly message: string };

const NETWORK: Failure = {
  ok: false,
  code: "network_error",
  message: "Kobe is unreachable. Check your connection and try again.",
};
const FAILED: Failure = { ok: false, code: "call_failed", message: "The app's call failed." };

function appPath(appId: string, rest: string): string {
  if (!APP_ID.test(appId)) throw new Error("not an app id");
  return `/v1/team/apps/${appId}/${rest}`;
}

/** The document of an app's iframe: Kobe's member frame route (spec MA4 as amended). */
export function appFrameUrl(appId: string, teamId: string, sha256: string): string {
  if (!UUID.test(teamId) || !SHA256.test(sha256)) throw new Error("not a frame request");
  const query = new URLSearchParams({ team: teamId, sha256 });
  return `${appPath(appId, "frame")}?${query.toString()}`;
}

async function send(
  path: string,
  teamId: string,
  fetchFn: typeof fetch,
  body?: unknown,
): Promise<{ status: number; json: unknown } | Failure> {
  const headers = new Headers({ accept: "application/json", [TEAM_HEADER]: teamId });
  if (body !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetchFn(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return NETWORK;
  }
  try {
    return { status: res.status, json: (await res.json()) as unknown };
  } catch {
    return FAILED;
  }
}

function refusal(json: unknown): Failure {
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (typeof error?.code !== "string" || typeof error.message !== "string") return FAILED;
  return {
    ok: false,
    code: error.code.slice(0, 64),
    message: error.message.slice(0, MESSAGE_MAX),
  };
}

export async function callAppTool(
  appId: string,
  teamId: string,
  tool: string,
  args: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
  /** The thread on screen, for a rail picker's call (KOBE-460); a card's call names none. */
  threadId?: string | null,
): Promise<ToolCallAnswer> {
  if (threadId != null && !UUID.test(threadId)) throw new Error("not a thread id");
  const sent = await send(appPath(appId, "calls"), teamId, fetchFn, {
    tool,
    arguments: args,
    ...(threadId == null ? {} : { thread_id: threadId }),
  });
  if ("ok" in sent) return sent;
  const result = (sent.json as { result?: unknown } | null)?.result;
  if (sent.status === 200 && typeof result === "object" && result !== null) {
    return { ok: true, result };
  }
  return refusal(sent.json);
}

export async function listAppTools(
  appId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ToolListAnswer> {
  const sent = await send(appPath(appId, "tools"), teamId, fetchFn);
  if ("ok" in sent) return sent;
  const tools = (sent.json as { tools?: unknown } | null)?.tools;
  if (sent.status === 200 && Array.isArray(tools)) return { ok: true, tools };
  return refusal(sent.json);
}

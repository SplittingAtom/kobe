import type { Hono } from "hono";
import { logger } from "../logger.js";
import {
  isWriteTool,
  KOBE_RESULT_MAX_BYTES,
  type KobeRoute,
  type KobeRouteAnswer,
  type KobeRouteCaller,
  type KobeTool,
} from "./catalog.js";
import { delegationEnv, type Delegation } from "./delegation.js";

/**
 * The Kobe MCP executor (KOBE-619, spec §3): runs a tool's console route in process, as the
 * delegated person, after the server decided the call `allow` for exactly this run, tool call and
 * input. Writes first re-read their before-state (§5); the answer is reduced to the tool's output
 * schema and capped before it reaches the model.
 */

/** What the model gets: an MCP `tools/call` result, or a tool error. */
export type KobeExecution =
  | {
      readonly ok: true;
      readonly result: {
        readonly content: readonly { readonly type: "text"; readonly text: string }[];
        readonly structuredContent: Record<string, unknown>;
      };
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Paths are built from validated ids only; anything else never reaches the router. */
const SAFE_PATH = /^\/(?:[A-Za-z0-9_-]+\/?)+$/;

export function routeCaller(api: Hono, delegation: Delegation): KobeRouteCaller {
  return async (route: KobeRoute): Promise<KobeRouteAnswer> => {
    if (!SAFE_PATH.test(route.path) || route.path.includes("..")) {
      throw new Error("kobe-mcp: unsafe route path");
    }
    const hasBody = route.body !== undefined;
    const res = await api.request(
      `/v1${route.path}`,
      {
        method: route.method,
        headers: hasBody ? { "content-type": "application/json" } : {},
        ...(hasBody ? { body: JSON.stringify(route.body) } : {}),
      },
      // A fresh delegation per route call: the env is the only place it exists.
      delegationEnv(delegation),
    );
    const text = await res.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: res.status, body };
  };
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A refusal from the route: its machine code and a short message, never more of its body. */
function routeError(answer: KobeRouteAnswer): { code: string; message: string } {
  const body = (typeof answer.body === "object" && answer.body !== null ? answer.body : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const code =
    typeof body.code === "string" && CODE.test(body.code)
      ? body.code
      : answer.status === 403
        ? "forbidden"
        : "failed";
  const message =
    typeof body.message === "string"
      ? body.message.slice(0, 300)
      : `Kobe answered ${answer.status}.`;
  return { code, message };
}

export async function executeKobeTool(
  api: Hono,
  delegation: Delegation,
  tool: KobeTool,
  input: unknown,
): Promise<KobeExecution> {
  try {
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: "The tool input is not valid." };
    }
    const call = routeCaller(api, delegation);
    if (isWriteTool(tool)) {
      const state = await tool.before(parsed.data, call);
      if (state !== "same") {
        return {
          ok: false,
          code: "changed_since_approval",
          message:
            "The target changed since this call was approved, so nothing was changed. Read it again and ask for a new approval.",
        };
      }
    }
    const answer = await call(tool.route(parsed.data));
    if (answer.status < 200 || answer.status > 299) {
      const error = routeError(answer);
      return { ok: false, code: error.code, message: `Kobe refused: ${error.message}` };
    }
    const output = tool.output.parse(tool.reduce(answer.body, parsed.data)) as Record<
      string,
      unknown
    >;
    const text = JSON.stringify(output);
    if (Buffer.byteLength(text, "utf8") > KOBE_RESULT_MAX_BYTES) {
      return { ok: false, code: "too_large", message: "The result is too large; ask for a page." };
    }
    return { ok: true, result: { content: [{ type: "text", text }], structuredContent: output } };
  } catch (err) {
    logger.error({ err, tool: tool.name, runId: delegation.runId }, "kobe-mcp: tool failed");
    return { ok: false, code: "failed", message: "Kobe could not run this tool. Try again." };
  }
}

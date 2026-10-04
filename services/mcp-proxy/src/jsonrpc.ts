import { parseJsonStrict } from "@kobe/protocol";

/**
 * JSON-RPC 2.0 as MCP Streamable HTTP uses it (one message per POST; batches were removed in MCP
 * 2025-06-18). Parsing is strict (`parseJsonStrict`: duplicate keys, U+0000, `__proto__` and deep
 * nesting are refused), because the parsed tool input is what gets decided, signed and forwarded.
 */

export type JsonRpcId = string | number;

export const JSONRPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type IncomingMessage =
  | {
      readonly kind: "request";
      readonly id: JsonRpcId;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "response" };

export type ParseResult =
  | { readonly ok: true; readonly message: IncomingMessage }
  | { readonly ok: false; readonly code: number; readonly message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const validId = (id: unknown): id is JsonRpcId =>
  (typeof id === "string" && id.length <= 256) ||
  (typeof id === "number" && Number.isSafeInteger(id));

export function parseMessage(text: string): ParseResult {
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) {
    return { ok: false, code: JSONRPC_ERRORS.parse, message: `Parse error (${parsed.issue}).` };
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    return {
      ok: false,
      code: JSONRPC_ERRORS.invalidRequest,
      message: "Batches are not supported.",
    };
  }
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    return {
      ok: false,
      code: JSONRPC_ERRORS.invalidRequest,
      message: "Not a JSON-RPC 2.0 message.",
    };
  }
  if (typeof value.method === "string") {
    if (value.method.length === 0 || value.method.length > 128) {
      return { ok: false, code: JSONRPC_ERRORS.invalidRequest, message: "Invalid method." };
    }
    if (!("id" in value))
      return { ok: true, message: { kind: "notification", method: value.method } };
    if (!validId(value.id)) {
      return { ok: false, code: JSONRPC_ERRORS.invalidRequest, message: "Invalid id." };
    }
    return {
      ok: true,
      message: { kind: "request", id: value.id, method: value.method, params: value.params },
    };
  }
  if ("result" in value || "error" in value) return { ok: true, message: { kind: "response" } };
  return { ok: false, code: JSONRPC_ERRORS.invalidRequest, message: "Not a JSON-RPC 2.0 message." };
}

export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

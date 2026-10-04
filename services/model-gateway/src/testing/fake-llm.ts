import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A fake model provider for tests and the k3d e2e suite (CI has no real provider keys): answers
 * the OpenAI chat API (also what Bifrost's Ollama and OpenAI-compatible providers speak), the
 * Anthropic Messages API and Gemini `generateContent`, streaming or not. Every reply names the
 * protocol it came through (`fake-openai: …`) and echoes the last user text, so a test can tell
 * which upstream answered. `GET /_seen` lists the credentials each request carried (e2e asserts
 * that provider keys arrive and sandbox credentials never do).
 */
export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  /** Header name → value for the credential headers present. */
  readonly credentials: Readonly<Record<string, string>>;
  /** Chat Completions: whether the request asked for its usage report (KOBE-43 e2e). */
  readonly includeUsage?: boolean;
}

const CREDENTIALS = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "x-bf-vk"];

function lastUserText(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const messages = (b.messages ?? b.contents ?? []) as Record<string, unknown>[];
  const last = messages.at(-1) ?? {};
  const content = last.content ?? last.parts;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => ((p as Record<string, unknown>).text as string | undefined) ?? "")
      .join("");
  }
  return "";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sse(res: ServerResponse, events: readonly string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(e);
  res.end();
}

function openai(res: ServerResponse, reply: string, stream: boolean, model: string): void {
  if (!stream) {
    json(res, 200, {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    return;
  }
  const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  sse(res, [
    chunk({ role: "assistant", content: "" }, null),
    ...reply.split(" ").map((w, i) => chunk({ content: i === 0 ? w : ` ${w}` }, null)),
    chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
    "data: [DONE]\n\n",
  ]);
}

function anthropic(res: ServerResponse, reply: string, stream: boolean, model: string): void {
  const usage = { input_tokens: 5, output_tokens: 3 };
  if (!stream) {
    json(res, 200, {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
    return;
  }
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  sse(res, [
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage,
      },
    }),
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: reply },
    }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    }),
    ev("message_stop", { type: "message_stop" }),
  ]);
}

function gemini(res: ServerResponse, reply: string, stream: boolean): void {
  const body = {
    candidates: [
      { content: { role: "model", parts: [{ text: reply }] }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  };
  if (!stream) json(res, 200, body);
  else sse(res, [`data: ${JSON.stringify(body)}\n\n`]);
}

export function createFakeLlm(seen: SeenRequest[] = []): Server {
  const handle = (req: IncomingMessage, res: ServerResponse, raw: Buffer) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    if (url.pathname === "/_seen") {
      json(res, 200, { requests: seen.slice(-200) });
      return;
    }
    if (url.pathname === "/healthz") {
      json(res, 200, { status: "ok" });
      return;
    }
    const credentials: Record<string, string> = {};
    for (const name of CREDENTIALS) {
      const v = req.headers[name];
      if (typeof v === "string") credentials[name] = v;
    }
    let body: Record<string, unknown>;
    try {
      body = raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
    } catch {
      seen.push({ method: req.method ?? "", path: url.pathname, credentials });
      json(res, 400, { error: { message: "invalid JSON" } });
      return;
    }
    const options = body.stream_options as Record<string, unknown> | undefined;
    seen.push({
      method: req.method ?? "",
      path: url.pathname,
      credentials,
      ...(url.pathname.endsWith("/chat/completions")
        ? { includeUsage: options?.include_usage === true }
        : {}),
    });
    const text = lastUserText(body);
    const model = typeof body.model === "string" ? body.model : "fake-model";
    const stream = body.stream === true || url.searchParams.get("alt") === "sse";
    const p = url.pathname;
    if (req.method === "GET" && /\/models$/.test(p)) {
      json(res, 200, {
        object: "list",
        data: [{ id: "fake-model", object: "model", owned_by: "fake" }],
      });
    } else if (p.endsWith("/chat/completions")) {
      openai(res, `fake-openai: ${text}`, stream, model);
    } else if (p.endsWith("/v1/messages")) {
      anthropic(res, `fake-anthropic: ${text}`, stream, model);
    } else if (/:(stream)?generateContent$/i.test(p)) {
      gemini(res, `fake-gemini: ${text}`, stream || p.endsWith(":streamGenerateContent"));
    } else {
      json(res, 404, { error: { message: `fake upstream: no route ${p}` } });
    }
  };
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
}

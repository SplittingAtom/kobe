// Capture server: stands in for every upstream provider Bifrost calls. Records each request
// (method, path, selected headers, raw body) and answers with a small canned response in the
// API's shape (JSON, or SSE when the body asks to stream). GET /__captured returns everything
// recorded since the last call and clears it. No dependencies; Node 22+.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9000);
let captured = [];

const usage = { input_tokens: 10, output_tokens: 5 };

function anthropic(stream) {
  const msg = {
    id: "msg_capture",
    type: "message",
    role: "assistant",
    model: "capture",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
  if (!stream) return { json: msg };
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return {
    sse:
      ev("message_start", { message: { ...msg, content: [], stop_reason: null } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }) +
      ev("message_stop", {}),
  };
}

function chat(stream) {
  const u = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const base = { id: "chatcmpl-capture", created: 1, model: "capture" };
  if (!stream) {
    return {
      json: {
        ...base,
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: u,
      },
    };
  }
  const chunk = (o) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...o })}\n\n`;
  return {
    sse:
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      chunk({ choices: [], usage: u }) +
      "data: [DONE]\n\n",
  };
}

function responses(stream) {
  const resp = {
    id: "resp_capture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "capture",
    output: [
      {
        type: "message",
        id: "msg_capture",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  if (!stream) return { json: resp };
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return {
    sse:
      ev("response.created", {
        sequence_number: 0,
        response: { ...resp, status: "in_progress", output: [] },
      }) +
      ev("response.output_text.delta", {
        sequence_number: 1,
        item_id: "msg_capture",
        output_index: 0,
        content_index: 0,
        delta: "ok",
      }) +
      ev("response.completed", { sequence_number: 2, response: resp }),
  };
}

function answer(path, body) {
  let stream = false;
  try {
    stream = JSON.parse(body).stream === true;
  } catch {
    // not JSON: answer as non-streaming
  }
  if (path.endsWith("/messages")) return anthropic(stream);
  if (path.endsWith("/responses")) return responses(stream);
  if (path.endsWith("/chat/completions")) return chat(stream);
  if (path.endsWith("/models")) return { json: { object: "list", data: [] } };
  return { status: 404, json: { error: "capture: unknown path" } };
}

const KEEP = ["content-type", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta"];

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://capture.invalid");
    if (url.pathname === "/__captured") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(captured));
      captured = [];
      return;
    }
    captured.push({
      method: req.method,
      path: url.pathname,
      headers: Object.fromEntries(
        KEEP.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]),
      ),
      body,
    });
    const out = answer(url.pathname, body);
    if (out.sse !== undefined) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(out.sse);
      return;
    }
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.json));
  });
}).listen(PORT, () => console.log(`capture listening on ${PORT}`));

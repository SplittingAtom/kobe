// Builds the request cases: Pi-style bodies run through the model gateway's own rewrite
// (applyThinking, then withStreamUsage for streaming Chat Completions, in gateway.ts's order),
// plus raw bodies that bypass the gateway (duplicate keys, no thinking control).
// Usage: node make-cases.mjs > cases.json  (after `pnpm --filter @kobe/model-gateway build`)
import { applyThinking } from "../../services/model-gateway/dist/thinking.js";
import { topLevelModel, withStreamUsage } from "../../services/model-gateway/dist/body-model.js";
import { classify } from "../../services/model-gateway/dist/routes.js";

const LEVELS = ["off", "low", "medium", "high"];
const policy = (control) => ({
  control,
  allowed: true,
  default: "medium",
  max: "high",
  lowest: "off",
});

const sys = [{ type: "text", text: "You are Pi.", cache_control: { type: "ephemeral" } }];
const anthropicMessages = [
  {
    role: "user",
    content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
  },
];
const chatMessages = [
  { role: "system", content: "You are Pi." },
  { role: "user", content: "Hello" },
];

/** What Pi 1.4 sends per API, with its own reasoning fields (the gateway strips them). */
const pi = {
  anthropic: (model, maxTokens) => ({
    model,
    max_tokens: maxTokens,
    system: sys,
    messages: anthropicMessages,
    thinking: { type: "enabled", budget_tokens: 16000 },
    stream: true,
  }),
  chat: (model, maxTokens) => ({
    model,
    messages: chatMessages,
    max_completion_tokens: maxTokens,
    reasoning_effort: "xhigh",
    stream: true,
    stream_options: { include_usage: true },
  }),
  responses: (model, maxTokens) => ({
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    instructions: "You are Pi.",
    max_output_tokens: maxTokens,
    reasoning: { effort: "xhigh", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  }),
};

/** The gateway's rewrite for one body, in gateway.ts order. */
function throughGateway(path, body, control, level) {
  const route = classify("POST", path);
  const buf = Buffer.from(JSON.stringify(body));
  const scanned = topLevelModel(buf);
  if (!scanned.ok) throw new Error(`gateway refuses ${path}: ${scanned.reason}`);
  let out = buf;
  if (control !== undefined) {
    const r = applyThinking(buf, route, policy(control), level);
    if (!r.ok) return { refused: `${r.code}: ${r.message}` };
    out = r.body;
  }
  if (scanned.stream && path === "/v1/chat/completions") out = withStreamUsage(out);
  return { body: out.toString("utf8") };
}

const cases = [];
const add = (c) => cases.push(c);

const MATRIX = [
  {
    shape: "anthropic",
    path: "/anthropic/v1/messages",
    model: "anthropic/claude-sonnet-4-5",
    control: "anthropic_budget",
    limits: [32000, 4096],
  },
  {
    shape: "anthropic",
    path: "/anthropic/v1/messages",
    model: "anthropic/claude-opus-4-6",
    control: "anthropic_adaptive",
    limits: [32000],
  },
  {
    shape: "anthropic",
    path: "/anthropic/v1/messages",
    model: "anthropic/claude-opus-4-7",
    control: "anthropic_effort",
    limits: [32000],
  },
  {
    shape: "chat",
    path: "/v1/chat/completions",
    model: "openai/gpt-5.1",
    control: "reasoning_effort",
    limits: [16384],
  },
  {
    shape: "responses",
    path: "/v1/responses",
    model: "openai/gpt-5.1",
    control: "reasoning_effort",
    limits: [16384],
  },
  {
    shape: "chat",
    path: "/v1/chat/completions",
    model: "ollama/gpt-oss:120b",
    control: "reasoning_effort",
    limits: [16384],
  },
  {
    shape: "responses",
    path: "/v1/responses",
    model: "ollama/gpt-oss:120b",
    control: "reasoning_effort",
    limits: [16384],
  },
  {
    shape: "chat",
    path: "/v1/chat/completions",
    model: "compat/qwen3-coder",
    control: "reasoning_effort",
    limits: [16384],
  },
];

for (const m of MATRIX) {
  for (const limit of m.limits) {
    for (const level of LEVELS) {
      const r = throughGateway(m.path, pi[m.shape](m.model, limit), m.control, level);
      add({ id: `${m.model} ${m.control} ${level} limit=${limit}`, path: m.path, ...r });
    }
  }
}

// Structured output beside adaptive thinking: the gateway keeps output_config.format.
{
  const body = {
    ...pi.anthropic("anthropic/claude-opus-4-6", 32000),
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
      },
      effort: "max",
    },
  };
  add({
    id: "anthropic/claude-opus-4-6 anthropic_adaptive high + output_config.format",
    path: "/anthropic/v1/messages",
    ...throughGateway("/anthropic/v1/messages", body, "anthropic_adaptive", "high"),
  });
}

// Non-streaming variants (no stream_options appended).
add({
  id: "openai/gpt-5.1 chat medium stream=false",
  path: "/v1/chat/completions",
  ...throughGateway(
    "/v1/chat/completions",
    { ...pi.chat("openai/gpt-5.1", 16384), stream: false, stream_options: undefined },
    "reasoning_effort",
    "medium",
  ),
});
add({
  id: "anthropic/claude-sonnet-4-5 budget medium stream=false",
  path: "/anthropic/v1/messages",
  ...throughGateway(
    "/anthropic/v1/messages",
    { ...pi.anthropic("anthropic/claude-sonnet-4-5", 32000), stream: false },
    "anthropic_budget",
    "medium",
  ),
});

// A Claude Code user agent switches Bifrost's Anthropic route to raw passthrough.
add({
  id: "anthropic/claude-sonnet-4-5 budget medium UA=claude-cli",
  path: "/anthropic/v1/messages",
  headers: { "user-agent": "claude-cli/2.0.0 (external, cli)" },
  ...throughGateway(
    "/anthropic/v1/messages",
    pi.anthropic("anthropic/claude-sonnet-4-5", 32000),
    "anthropic_budget",
    "medium",
  ),
});

// Models without a thinking control: Pi's body passes unchanged (Bifrost alone shapes it).
add({
  id: "ollama/gpt-oss:120b no control, Pi xhigh (chat)",
  path: "/v1/chat/completions",
  ...throughGateway("/v1/chat/completions", pi.chat("ollama/gpt-oss:120b", 16384), undefined),
});
add({
  id: "ollama/gpt-oss:120b no control, Pi xhigh (responses)",
  path: "/v1/responses",
  ...throughGateway("/v1/responses", pi.responses("ollama/gpt-oss:120b", 16384), undefined),
});
add({
  id: "openai/gpt-5.1 no control, Pi xhigh (chat)",
  path: "/v1/chat/completions",
  ...throughGateway("/v1/chat/completions", pi.chat("openai/gpt-5.1", 16384), undefined),
});
add({
  id: "anthropic/claude-sonnet-4-5 via chat completions, cache_control on messages",
  path: "/v1/chat/completions",
  ...throughGateway(
    "/v1/chat/completions",
    {
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 4096,
      stream: false,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "You are Pi.", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
        },
      ],
    },
    undefined,
  ),
});

// Raw duplicate-key bodies (never produced by the gateway; a direct client or an append bug).
const raw = (id, path, text) => add({ id, path, raw: true, body: text });
raw(
  "DUP anthropic thinking: Pi first, gateway second",
  "/anthropic/v1/messages",
  '{"model":"anthropic/claude-sonnet-4-5","max_tokens":32000,"stream":false,"messages":[{"role":"user","content":"Hello"}],"thinking":{"type":"enabled","budget_tokens":16000},"thinking":{"type":"disabled"}}',
);
raw(
  "DUP anthropic thinking: budget then adaptive",
  "/anthropic/v1/messages",
  '{"model":"anthropic/claude-opus-4-6","max_tokens":32000,"stream":false,"messages":[{"role":"user","content":"Hello"}],"thinking":{"type":"enabled","budget_tokens":16000},"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"max"},"output_config":{"effort":"low"}}',
);
raw(
  "DUP anthropic max_tokens + case variant",
  "/anthropic/v1/messages",
  '{"model":"anthropic/claude-sonnet-4-5","max_tokens":32000,"MAX_TOKENS":2000,"stream":false,"messages":[{"role":"user","content":"Hello"}]}',
);
raw(
  "DUP anthropic Thinking (case) then thinking",
  "/anthropic/v1/messages",
  '{"model":"anthropic/claude-sonnet-4-5","max_tokens":32000,"stream":false,"messages":[{"role":"user","content":"Hello"}],"Thinking":{"type":"enabled","budget_tokens":16000},"thinking":{"type":"enabled","budget_tokens":2048}}',
);
raw(
  "DUP responses reasoning: Pi first, gateway second",
  "/v1/responses",
  '{"model":"openai/gpt-5.1","input":"Hello","stream":false,"reasoning":{"effort":"xhigh","summary":"auto"},"reasoning":{"effort":"low"}}',
);
raw(
  "DUP chat reasoning_effort twice",
  "/v1/chat/completions",
  '{"model":"openai/gpt-5.1","messages":[{"role":"user","content":"Hello"}],"stream":false,"reasoning_effort":"xhigh","reasoning_effort":"low"}',
);
raw(
  "DUP chat stream_options (withStreamUsage append)",
  "/v1/chat/completions",
  '{"model":"openai/gpt-5.1","messages":[{"role":"user","content":"Hello"}],"stream":true,"stream_options":{"include_usage":false,"include_obfuscation":false},"stream_options":{"include_usage":true}}',
);
raw(
  "DUP chat reasoning object + reasoning_effort",
  "/v1/chat/completions",
  '{"model":"openai/gpt-5.1","messages":[{"role":"user","content":"Hello"}],"stream":false,"reasoning":{"effort":"high"},"reasoning_effort":"low"}',
);

process.stdout.write(JSON.stringify(cases, null, 1));

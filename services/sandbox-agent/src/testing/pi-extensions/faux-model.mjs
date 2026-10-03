// Test-only Pi extension: a scripted model (pi-ai's faux provider), so real Pi 1.0.0 issues tool
// calls without credentials. The script is the user prompt: `faux:` + a JSON array of steps, each
// `{ "tool", "args", "id" }` (one tool call), `{ "calls": [...] }` (parallel calls in one message)
// or `{ "text" }`. The n-th assistant message after the prompt plays step n (then "done").
// It selects its model on every prompt (an `input` handler runs before Pi checks the model, while
// `session_start` may still be pending when the first prompt arrives) and activates `codemode` when the built-in is loaded (it
// registers inactive). Pi needs a writable PI_CODING_AGENT_DIR to use any provider (it opens its
// credential store there), so tests using this extension give Pi one.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function step(context) {
  const messages = context.messages ?? [];
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && textOf(messages[i]).startsWith("faux:")) {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) return fauxAssistantMessage("no script");
  const steps = JSON.parse(textOf(messages[userIndex]).slice("faux:".length));
  const played = messages.slice(userIndex + 1).filter((m) => m.role === "assistant").length;
  const next = steps[played] ?? { text: "done" };
  const calls = next.calls ?? (next.tool === undefined ? [] : [next]);
  if (calls.length === 0) return fauxAssistantMessage(next.text ?? "done");
  return fauxAssistantMessage(
    calls.map((c) => fauxToolCall(c.tool, c.args, { id: c.id })),
    { stopReason: "toolUse" },
  );
}

export default function (pi) {
  const faux = fauxProvider({ provider: "kobe-faux", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 500 }, () => step));
  pi.registerProvider(faux.provider);
  const prepare = async (_event, ctx) => {
    if (ctx.model?.provider !== "kobe-faux") await pi.setModel(faux.getModel());
    const active = pi.getActiveTools();
    if (!active.includes("codemode") && pi.getAllTools().some((t) => t.name === "codemode")) {
      pi.setActiveTools([...active, "codemode"]);
    }
  };
  pi.on("session_start", prepare);
  pi.on("input", prepare);
}

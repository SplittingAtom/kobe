// Test-only Pi extension: a scripted model (pi-ai's faux provider), so real Pi 1.0.0 issues tool
// calls without credentials. The script is the user prompt: `faux:` + a JSON array of steps, each
// `{ "tool", "args", "id" }` (one tool call), `{ "calls": [...] }` (parallel calls in one message),
// `{ "text" }`, `{ "thinking", "stopReason" }` (reasoning only, e.g. cut off at the output limit,
// KOBE-258), `{ "echoUsers": true }` (replies with every user message the model was given) or
// `{ "waitForAbort": true }` (no first token until the run is aborted: Stop before the answer,
// KOBE-290) or `{ "countInSystem": [base64...] }` (replies `COUNTS:[n, ...]`, how often each
// decoded needle occurs in the system prompt, so neither the needle nor the prompt lands in the
// session, KOBE-473) or `{ "countInMessages": [base64...] }` (the same over the non-system
// messages, KOBE-492).
// The n-th assistant message after the prompt plays step n (then "done").
// It selects its model on every prompt (an `input` handler runs before Pi checks the model, while
// `session_start` may still be pending when the first prompt arrives) and activates `codemode` when the built-in is loaded (it
// registers inactive). Pi needs a writable PI_CODING_AGENT_DIR to use any provider (it opens its
// credential store there), so tests using this extension give Pi one.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Resolves when the call's signal aborts (or after 60 s, so a stuck test still ends). */
function aborted(signal) {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) return resolve();
    const timer = setTimeout(resolve, 60_000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function step(context, options) {
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
  if (next.waitForAbort) {
    await aborted(options?.signal);
    return fauxAssistantMessage("too late");
  }
  // KOBE-123: reply with the system prompt the model was given.
  if (next.echoSystemPrompt) {
    // Pi 1.0.0 carries the prompt as system messages: `content` plus named, ordered `sections`
    // (Pi's own, then `addendum` for --append-system-prompt).
    const system = messages.filter((m) => m.role === "system" || m.role === "developer");
    const rendered = system.map((m) => [textOf(m), ...Object.values(m.sections ?? {})].join("\n"));
    return fauxAssistantMessage(`SYSTEM:${rendered.join("\n")}`);
  }
  if (next.countInSystem !== undefined) {
    const system = messages.filter((m) => m.role === "system" || m.role === "developer");
    const text = system
      .map((m) => [textOf(m), ...Object.values(m.sections ?? {})].join("\n"))
      .join("\n");
    const counts = next.countInSystem.map((b64) => {
      const needle = Buffer.from(b64, "base64").toString("utf8");
      return text.split(needle).length - 1;
    });
    return fauxAssistantMessage(`COUNTS:${JSON.stringify(counts)}`);
  }
  // KOBE-492: how often each needle occurs in the non-system messages the model was given (a
  // mid-run Kobe notice arrives as a custom message, which Pi sends in user role).
  if (next.countInMessages !== undefined) {
    const text = messages
      .filter((m) => m.role !== "system" && m.role !== "developer")
      .map((m) => textOf(m))
      .join("\n");
    const counts = next.countInMessages.map((b64) => {
      const needle = Buffer.from(b64, "base64").toString("utf8");
      return text.split(needle).length - 1;
    });
    return fauxAssistantMessage(`COUNTS:${JSON.stringify(counts)}`);
  }
  if (next.thinking !== undefined) {
    return fauxAssistantMessage([fauxThinking(next.thinking)], {
      stopReason: next.stopReason ?? "stop",
    });
  }
  if (next.echoUsers) {
    const users = messages.filter((m) => m.role === "user").map((m) => textOf(m));
    return fauxAssistantMessage(`USERS:${JSON.stringify(users)}`);
  }
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

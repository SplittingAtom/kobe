# KOBE-157: 56e Sandbox remember/recall tools and memory context injection

- **Status:** in review
- **Branch / worktree:** `kobe-157-sandbox-memory-tools` in `../Kobe-wt157`
- **Depends on:** [KOBE-153](KOBE-153.md) (contract), [KOBE-155](KOBE-155.md), [KOBE-156](KOBE-156.md) (server handler)

## Plan

Sandbox side only. kobe-tools registers `remember` / `recall`; the agent routes `memory.put` / `memory.read`
to the server (`tools/memory-broker.ts`); `run.start.memory` joins the system prompt (`memory/context.ts`).

## Decisions

- **Tools** (`kobe-tools/memory-tools.ts`): registered only when the agent sets `KOBE_TOOLS_MEMORY=1`
  (hello capability `memory`, announced whenever the tools extension is configured, like `web_search`).
  kobe-policy is the last extension, so it checks every call first; the broker sends the same
  `tool_call_id` with `memory.put` / `memory.read` (the server binds both to the allowed call, KOBE-156).
  Input is checked in the extension for shape only; the server decides everything else.
- **Wire:** `memory.put` / `memory.read` carry no `tool` field (memory.ts). The kobe-tools request/response
  unions in `packages/protocol/src/artifacts.ts` did not list them: added (additive, 4 lines) with the three
  missing `MemoryPutFrame` / `MemoryReadFrame` / `MemoryResultFrame` type exports. `ToolsRequest.tool` is
  optional in the extension; `ArtifactBroker` sends `tool` only when present.
- **Untrusted framing (both recall output and the injected index):** each file is wrapped in
  `<<<BEGIN UNTRUSTED MEMORY>>>` / `<<<END UNTRUSTED MEMORY>>>` with a `scope: .., file: ..` label line,
  and a notice that it is data, never instructions. Content is sanitised: CR/U+2028/2029 become LF, all other
  control characters (C0 except LF/TAB, DEL, C1) are removed, and `<<<` becomes `< < <` so content cannot
  forge a fence. Same helper for both (`sanitizeUntrusted`, `untrustedMemoryBlock`).
- **Caps:** recall output at most 32 KiB in total (content cut, notice added); each injected index at most
  12 KiB; the memory section is dropped whole (never cut through a fence) when the agent's own system prompt
  leaves no room under `SYSTEM_PROMPT_MAX_BYTES`.
- **Injection:** `buildPiLaunch` appends the section to the agent's system prompt (`--append-system-prompt`
  file, KOBE-123) and puts the result in the launch key. Only indexes of scopes listed in
  `memory.scopes` are used; empty/absent index, empty scopes or no `memory` field give no section at all.
  Consequence: an index that changed since the last run restarts an idle Pi at the next `run.start`
  (session file restores context); an unchanged index does not. `ThreadManager` treats a `memory` field
  as a launch input change like `mcp`.
- **No system-prompt arg change:** the existing `--append-system-prompt` path is reused, nothing new at Pi launch.
- `agent.runs.test.ts` env probe: the fake Pi does not strip `KOBE_TOOLS_MEMORY` like the real extension does.

## Open questions

- A mid-run `remember` is not visible in the injected index until the next run (by design: topic files via `recall`).
- Pi restarts when the index changes; if that proves slow, move the section to a per-run Pi message instead.

## Evidence

- ac-1: `kobe-tools.memory.real-pi.test.ts` (real Pi 1.0.0, run locally from `images/sandbox/pi`; CI installs the
  same Pi and runs it): "lists remember and recall", "runs kobe-policy before remember", "before recall";
  unit: `kobe-tools/memory-tools.test.ts`, `tools/memory-broker.test.ts`.
- ac-2: same file, "injects the index as untrusted data, and nothing when memory is off";
  unit: `memory/context.test.ts`, `pi/pi-launch.test.ts` ("buildPiLaunch memory").
- ac-3: `kobe-tools.memory.real-pi.test.ts` (7 tests).

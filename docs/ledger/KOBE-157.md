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
- **Untrusted framing (recall output and injected index; `kobe-tools/memory-fence.ts`):** each file sits in
  `<<<BEGIN UNTRUSTED MEMORY <nonce>>>>` / `<<<END UNTRUSTED MEMORY <nonce>>>>`; the nonce is random per recall and per
  run, so text written earlier cannot close the fence even if a look-alike slips past. Sanitising: NFKC (fullwidth
  folds to ASCII), strip `\p{Cf}` (zero-width, bidi, BOM, Unicode tag block), variation selectors, C0/C1 controls
  (LF/TAB kept), line separators become LF, then `<<<` runs are broken up. Same for labels (scope, file, provenance).
- **Provenance:** `run.start.memory.indexes[].written_by` (`agent`|`person`, new optional field, server fills it from the
  current version's actor). Label: "last written by the agent and approved by a project member" (agent writes to
  project memory only land after approval), "last edited by a person", or none. The approver's identity is not
  stored; naming them needs a migration (follow-up, with an author/approver name for KOBE-158's panel).
- **Caps:** recall 8 KiB per file inside 32 KiB total (a note inside the fence, END kept); each injected index 12 KiB;
  a section that would not fit under the system prompt limit is dropped whole.
- **Injection is per run, not part of the launch (review of #205):** the agent writes `memory-context.json` in Pi's
  runtime dir (like `model.json`: atomic, tripwire-verified, env `KOBE_MEMORY_FILE`) before every prompt:
  `{tools, text}`. kobe-tools reads it: `input` hook activates/deactivates `remember`/`recall` (tools listed only when
  memory is on for the run: some scope enabled), `before_agent_start` appends `text` to that run's system prompt
  only (not persisted in the session). A changed index or switch never changes the launch key, so no Pi restart.
  Missing/malformed file = no tools, no text.
- **Approval card = stored content:** kobe-tools' `tool_call` hook strips invisible characters from `remember`
  content before kobe-policy's check (policy loads last), so the policy input, the HMAC-signed input and the card all
  show what is stored. Web-side rendering of the card (escape/mark invisible characters in other content) is KOBE-158's area.
- `agent.runs.test.ts` env probe: the fake Pi does not strip `KOBE_TOOLS_MEMORY` like the real extension does.

## Open questions

- A mid-run `remember` is not visible in the injected index until the next run (by design: topic files via `recall`).
- Approver identity/name in provenance (migration). Card rendering of invisible characters in non-remember input: KOBE-158.

## Evidence

- ac-1: `kobe-tools.memory.real-pi.test.ts` (real Pi 1.0.0, run locally from `images/sandbox/pi`; CI installs the
  same Pi and runs it): "lists remember and recall", "runs kobe-policy before remember", "before recall";
  unit: `kobe-tools/memory-tools.test.ts`, `tools/memory-broker.test.ts`.
- ac-2: same file, "injects the index as untrusted data, and nothing when memory is off";
  unit: `memory/context.test.ts`, `pi/pi-launch.test.ts` ("buildPiLaunch memory").
- ac-3: `kobe-tools.memory.real-pi.test.ts` (9 tests, incl. no-restart and tools-off).

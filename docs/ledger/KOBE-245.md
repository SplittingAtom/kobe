# KOBE-245: Project instructions are not applied in the sandbox

- **Status:** in review
- **Branch / worktree:** `kobe-245-project-instructions` in `../Kobe-wt245`
- **Depends on:** [KOBE-161](KOBE-161.md) (server sends `run.start.project`), [KOBE-157](KOBE-157.md) (per-run context file)

## Plan

Sandbox-agent only. The agent writes the project block into the same per-run file as the memory index
(`memory-context.json`, new `project` field); kobe-tools' `before_agent_start` appends it to that run's system
prompt after the memory text. Not Pi's launch key, so editing instructions never restarts Pi.

## Decisions

- **Gate:** the agent forwards `frame.project` only when it announced the `projects` capability
  (`projectTools`); non-project runs write an empty `project`, so nothing is added.
- **Independent of memory:** a project run with memory off still gets its instructions (`project` is read even when
  `tools` is false; memory `text` is still dropped then).
- **Trust choice:** instructions are written by project admins (owners), so unlike memory (written by people and
  earlier runs, approved by one member, read by all) they are not wrapped in the untrusted-data fence; the model is
  told to follow them, and told they do not change safety rules, tools or approvals (those stay server-side).
  They still pass the memory sanitiser (NFKC, no control or format characters, no `<<<`, so they cannot hide text or
  forge a memory fence) and are capped at 8 KiB (`memory/project-context.ts`; the server already caps at the same
  size, this is defence in depth). Name and mount are sanitised to one line.
- Label: `## Project instructions (set by project admins)`.

## Evidence

- ac-1: unit `memory/project-context.test.ts`, `kobe-tools/memory-hooks.test.ts`; real Pi
  `kobe-tools.project.real-pi.test.ts` (project run has instructions, next run changed without restart, non-project
  run none, no `projects` capability = none); e2e `run.sh` "projects (KOBE-164)" asserts the fake model's `system?`
  echo has the label and the instructions for a project thread and not for a plain thread.

---
name: skill-creator
description: "Create a new Kobe skill (a SKILL.md folder with optional scripts and references) or improve an existing one: interview the user, draft it in the workspace, test it on realistic prompts, check it against the Kobe upload rules and package it for My skills or the team. Use whenever the user wants to make, write, turn a workflow into, fix, test or tune a skill, even if they only say 'make this repeatable' or 'remember how to do this'."
---

# Skill creator

A skill is a folder with a `SKILL.md` (YAML frontmatter `name` and `description`, then Markdown
instructions) and optional `scripts/` and `references/`. The agent sees only the name and
description until it decides to use the skill, then reads the body and, as needed, the other files.

Everything here is offline: helper scripts use the Python standard library. Run them with `python`
(they are not executable files), using this skill's directory as the base. Build skills under
`/workspace/skills/<name>/`.

Work through the steps below in order, but match the user: if they already have a draft, start at
step 3; if they just want a quick skill, keep the interview short. Read
`references/writing-guide.md` before drafting.

## 1. Capture intent

If the conversation already shows the workflow (the user says "turn this into a skill"), take the
steps, tools, corrections and formats from it first, and ask only about the gaps. Settle:

1. What should the skill let the agent do, and what does a good result look like?
2. When should it trigger: which requests, phrasings and files?
3. Inputs and outputs: file types, where results go (`/workspace`), formats.
4. Hard rules: things that must always or never happen.
5. Two or three realistic test prompts the user would actually type.

Ask one or two questions at a time, not a questionnaire.

## 2. Scaffold and draft

```
python scripts/init_skill.py NAME [--dir /workspace/skills] [--scripts] [--references]
```

This creates `/workspace/skills/NAME/SKILL.md` with a template to replace, plus empty `scripts/` or
`references/` folders when asked. NAME is lowercase letters, digits and hyphens (up to 64), and it
is permanent once uploaded.

Write the description first (it decides whether the skill is ever used), then the body. Put
repeatable, deterministic work in a script instead of prose, and long reference material in
`references/` with a pointer from the body saying when to read it. Keep SKILL.md under about 500
lines.

## 3. Test it

Save the test prompts to `/workspace/skills/NAME/evals/evals.json`:

```json
{
  "skill": "NAME",
  "evals": [{ "id": 1, "prompt": "…", "expected": "what a good result contains" }]
}
```

For each prompt, do the task by following only the draft skill (re-read SKILL.md first; do not rely
on what you remember from the interview), saving outputs under `/workspace/skills/NAME-tests/eval-<id>/`.
Run every script the skill tells the agent to run. Then show the user the results, prompt by prompt,
and ask what is wrong or missing. Where a check is objective (a file exists, a total matches), state
it and whether it passed.

Also test triggering: write five prompts that should use the skill and five near misses that should
not, and judge from the description alone whether each would trigger. Tighten the wording when a
near miss would trigger or a real request would not.

## 4. Improve and repeat

Change the skill based on the feedback, then rerun the tests into `eval-<id>-v2/` and compare.
When improving:

- Generalize from the feedback; don't patch the one example. The skill will meet many prompts.
- Explain _why_ a rule matters instead of shouting MUST; the model follows reasons better.
- Cut instructions that did not change anything in the test runs.
- If every run wrote the same helper code, move it into `scripts/`.

Stop when the user is happy or the changes stop helping.

## 5. Validate and package

```
python scripts/validate.py /workspace/skills/NAME
python scripts/package.py /workspace/skills/NAME [--out /workspace/NAME.zip]
```

`validate.py` applies Kobe's upload rules (frontmatter, name, description length, file count and
sizes, safe paths, no symlinks) and reports what Kobe's scanner will flag. Errors block the upload;
fix them. Flags do not block, but a flagged skill waits for a team admin's review before anyone can
use it, so remove anything the skill does not need (network calls, package installs, secrets: the
sandbox has no internet access and no package installs anyway). `package.py` validates, writes a
zip with SKILL.md at its root (leaving out `evals/`, caches and hidden files), and prints how to
enter the skill in Kobe.

## 6. Add it to Kobe

Tell the user how, using `package.py`'s summary:

- **Just for them:** My skills → New skill. Paste the name, description and the SKILL.md body
  (everything after the closing `---`); for each file under `scripts/` or `references/`, choose
  Add file and paste its path and contents. Personal skills are only theirs and work in any of
  their teams unless a team admin turns personal skills off.
- **For the team:** a Builder or team admin creates it as a Team skill in the team's admin console
  (Skills → New skill); it may need a team admin's review before the team can use it.
- **To use it:** add the skill's name to an agent's `skills` list, or rely on the user's own
  enabled skills.

The browser editor takes text files only. The zip is for the skills API or for keeping a copy.

## Improving an existing skill

Ask the user to paste the current SKILL.md (and files) or put the bundle in the workspace, copy it to
`/workspace/skills/<name>/`, keep the same `name`, and run steps 3 to 6. Saving in the editor
creates a new version; agents pick it up on new runs.

# Writing a good skill

## The description is the trigger

The agent picks a skill from its name and description alone, and tends to under-use skills. So the
description must say both **what the skill does** and **when to use it**, in concrete terms the user
would type, and lean a little pushy:

- Weak: `Helps with invoices.`
- Better: `Turn supplier invoices (PDF or scans saved as PDF) into a checked CSV of line items with
totals reconciled. Use whenever the user uploads an invoice, asks to extract, total or check
invoice lines, or mentions accounts payable, even if they don't say "invoice".`

Limits: up to 1024 characters. Put it in double quotes in the frontmatter so colons and `#` are safe.

## The body

- Lead with the workflow as numbered steps; put background after.
- Use the imperative ("Read the file", "Save under /workspace").
- Explain why a rule exists. A model that understands the reason handles the cases the rule did
  not foresee; a bare MUST in capitals tends to be followed rigidly or ignored.
- Give one short worked example of input and output when the format matters.
- Name exact commands, paths and file formats. Say where outputs go (`/workspace`).
- Say what to do when things go wrong: missing input, a script error, an ambiguous request.
- Keep it under about 500 lines. If it grows, move detail into `references/` and say in the body
  which file to read for which situation.

## Progressive disclosure

1. Name and description: always in context, so keep them short and precise.
2. SKILL.md body: loaded when the skill triggers.
3. `references/` and `scripts/`: read or run only when the body says so. Scripts can do work
   without their source being read at all, which saves context.

## Scripts

- Python 3.12 or bash, standard library or the sandbox's preinstalled stack (pandas, numpy, DuckDB,
  pyarrow, matplotlib, openpyxl, python-docx, reportlab, pypdf). No package installs, no network.
- Scripts are not executable files: the skill must say `python scripts/x.py`, not `./x.py`.
- Print clear output the agent can read; exit non-zero with a message on bad input.
- Never put credentials in a skill. Connectors reach external services through Kobe's MCP proxy.

## Kobe constraints that matter

- The sandbox has no direct internet access; outbound traffic, where a team allows it, goes through
  Kobe's egress proxy. A skill should work offline unless the user explicitly needs otherwise.
- Network calls, package installs, piping downloads into a shell, obfuscated code and secret-shaped
  strings are flagged by Kobe's scanner; flagged skills wait for team-admin review.
- Built-in names are reserved: data-analysis, charts, docx, pdf, xlsx, code-review, skill-creator.

## Checklist before packaging

- [ ] Description says what and when, with words users actually use.
- [ ] Each step is something the agent can do with its tools in the sandbox.
- [ ] Every script the body mentions exists and ran during testing.
- [ ] No secrets, no network or installs the skill does not truly need.
- [ ] Test prompts ran and the user agreed with the results.

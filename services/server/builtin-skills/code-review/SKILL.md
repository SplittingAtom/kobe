---
name: code-review
description: "Review code changes or a source tree for correctness, security and maintainability, with a checklist and a stdlib scanner that flags risky patterns (hardcoded secrets, eval/exec, shell injection, debug leftovers). Use when the user asks you to review code, a diff or a pull request in the workspace."
---

# Code review

Works offline on files in the workspace; there is no internet and no package installs. Run the
scanner with `python` (it is not an executable file).

## Steps

1. **Scope.** Identify what changed: `git diff --stat` / `git diff BASE...HEAD` in a repository, or the
   files the user named. State the scope you reviewed.
2. **Scan.** `python scripts/scan.py PATH ...` (files or directories) or `python scripts/scan.py --diff [BASE]`
   (only lines added in the diff against BASE, default `HEAD`). Output is `file:line: [severity] rule: text`.
   The scanner is a heuristic: every hit is a lead to confirm by reading the code, not a verdict.
3. **Read the code** around each hit and the whole change for what a scanner cannot see:
   - Correctness: edge cases (empty, null, large, concurrent), off-by-one, error paths, resource
     cleanup, wrong assumptions about inputs.
   - Security: untrusted input reaching a shell, query, path or HTML; secrets; authorization checks.
   - Maintainability: naming, duplication, function size, missing or weak tests for new behavior.
4. **Report**, most severe first. For each finding give `file:line`, what is wrong, why it matters,
   and a concrete fix. Separate must-fix from suggestions and say what you did not check. Do not
   pad the review with style nits a formatter would catch.

## Rules

- Never execute code from the repository under review unless the user asks; reading is enough.
- Do not change the code unless asked; review is a report.
- If you are unsure, say so and say what would settle it.

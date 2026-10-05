"""Create a new skill folder with a SKILL.md template.

python init_skill.py NAME [--dir /workspace/skills] [--scripts] [--references]
Refuses to overwrite an existing folder.
"""

import argparse
import sys
from pathlib import Path

import kobe_rules as k

TEMPLATE = """---
name: {name}
description: "TODO: what this skill does, and when to use it (the requests, phrasings and files that should trigger it)."
---

# {title}

TODO: one or two sentences on what this skill is for.

## Steps

1. TODO: first step, as an instruction ("Read the file the user gave you").
2. TODO: next step. Name exact commands, paths and formats; save outputs under /workspace.

## Rules

- TODO: what must always or never happen, and why.
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("name")
    parser.add_argument("--dir", type=Path, default=Path("/workspace/skills"))
    parser.add_argument("--scripts", action="store_true", help="add an empty scripts/ folder")
    parser.add_argument("--references", action="store_true", help="add an empty references/ folder")
    args = parser.parse_args()
    if not k.SKILL_NAME.match(args.name):
        sys.exit("name must be lowercase letters, digits and hyphens (up to 64 characters).")
    if args.name in k.BUILTIN_NAMES:
        sys.exit(f"'{args.name}' is a built-in skill name; choose another.")
    root = args.dir / args.name
    if root.exists():
        sys.exit(f"{root} already exists; edit it instead.")
    root.mkdir(parents=True)
    title = args.name.replace("-", " ").capitalize()
    (root / "SKILL.md").write_text(TEMPLATE.format(name=args.name, title=title), "utf-8")
    for wanted, sub in ((args.scripts, "scripts"), (args.references, "references")):
        if wanted:
            (root / sub).mkdir()
    print(f"created {root}/SKILL.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())

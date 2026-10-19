"""Validate a skill folder and pack it into a zip Kobe accepts.

python package.py SKILL_DIR [--out /workspace/NAME.zip]
SKILL.md sits at the zip's root; evals/, caches and hidden files are left out. Refuses to package
a skill with validation errors.
"""

import argparse
import sys
import zipfile
from pathlib import Path

import kobe_rules as k
from validate import validate

FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def write_zip(root, files, out):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in files:
            info = zipfile.ZipInfo(rel.as_posix(), FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zf.writestr(info, (root / rel).read_bytes())


def print_how_to_add(root, files, out):
    fields, _ = k.parse_frontmatter((root / "SKILL.md").read_text("utf-8"))
    print(f"\nwrote {out} ({out.stat().st_size} bytes, {len(files)} files)")
    print(f"  Name:         {fields.get('name', '')}")
    print(f"  Description:  {fields.get('description', '')}")
    print("\nTo work on it in Kobe, save the folder with the save_skill_draft tool (or Save skill")
    print("to Workbench in this conversation); the zip is a copy, or for the Workbench's upload start.")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("skill_dir", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    root = args.skill_dir.resolve()
    errors, flags, warnings, files = validate(root)
    for item in errors:
        print(f"ERROR: {item}")
    if errors:
        print("not packaged: fix the errors above and run again.")
        return 1
    for item in flags:
        print(f"FLAG (team-admin review): {item}")
    for item in warnings:
        print(f"WARNING: {item}")
    out = (args.out or root.parent / f"{root.name}.zip").resolve()
    if root in out.parents:
        print("ERROR: write the zip outside the skill folder.")
        return 1
    write_zip(root, files, out)
    if out.stat().st_size > k.MAX_BUNDLE_BYTES:
        print(f"ERROR: {out} is over {k.MAX_BUNDLE_BYTES} bytes; Kobe will refuse it.")
        return 1
    print_how_to_add(root, files, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

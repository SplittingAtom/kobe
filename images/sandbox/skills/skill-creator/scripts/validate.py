"""Check a skill folder against Kobe's upload rules before packaging.

python validate.py SKILL_DIR
Prints errors (Kobe would refuse the upload), flags (Kobe's scanner would send the skill to
team-admin review) and warnings (likely problems). Exit status 1 when there are errors.
"""

import argparse
import re
import sys
from pathlib import Path

import kobe_rules as k


def bundle_files(root):
    """Files that go into the package, relative to root, sorted. Skips excluded dirs and files."""
    out = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if any(part in k.EXCLUDED_DIRS or part.startswith(".") for part in rel.parts[:-1]):
            continue
        if path.is_dir() and not path.is_symlink():
            continue
        if rel.name in k.EXCLUDED_FILES or rel.name.startswith(".") or rel.suffix == ".pyc":
            continue
        out.append(rel)
    return out


def check_skill_md(root, errors, warnings):
    md = root / "SKILL.md"
    if not md.is_file():
        errors.append("SKILL.md is missing at the top of the folder.")
        return
    raw = md.read_bytes()
    if len(raw) > k.MAX_SKILL_MD_BYTES:
        errors.append(f"SKILL.md is {len(raw)} bytes; the limit is {k.MAX_SKILL_MD_BYTES}.")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        errors.append("SKILL.md must be UTF-8 text.")
        return
    fields, problem = k.parse_frontmatter(text)
    if problem:
        errors.append(problem)
        return
    name, description = fields.get("name", ""), fields.get("description", "")
    if not k.SKILL_NAME.match(name):
        errors.append("name must be lowercase letters, digits and hyphens (up to 64 characters).")
    elif name != root.name:
        warnings.append(f"name '{name}' differs from the folder name '{root.name}'.")
    if name in k.BUILTIN_NAMES:
        errors.append(f"'{name}' is a built-in skill name; choose another.")
    if not description.strip() or len(description) > k.DESCRIPTION_MAX:
        errors.append(f"description is required (up to {k.DESCRIPTION_MAX} characters).")
    elif len(description) < 80 or "use" not in description.lower():
        warnings.append("description is short or never says when to use the skill; it decides triggering.")
    body = k.FENCE.sub("", text.lstrip("\ufeff"), count=1)
    if "TODO" in text:
        warnings.append("SKILL.md still has TODO placeholders from the template.")
    if len(body.splitlines()) > 500:
        warnings.append("SKILL.md body is over 500 lines; move detail into references/.")
    for ref in sorted(set(_mentioned_paths(body))):
        if not (root / ref).exists():
            warnings.append(f"SKILL.md mentions {ref}, which does not exist.")


def _mentioned_paths(body):
    return re.findall(r"\b((?:scripts|references|assets)/[\w./-]+\w)", body)


def check_files(root, files, errors, flags, warnings):
    if len(files) > k.MAX_FILES:
        errors.append(f"{len(files)} files; the limit is {k.MAX_FILES}.")
    total = 0
    for rel in files:
        path = root / rel
        if path.is_symlink():
            errors.append(f"{rel}: symlinks are not allowed.")
            continue
        size = path.stat().st_size
        total += size
        if size > k.MAX_FILE_BYTES:
            errors.append(f"{rel}: {size} bytes; the limit per file is {k.MAX_FILE_BYTES}.")
        if len(str(rel).encode()) > k.MAX_PATH_BYTES:
            errors.append(f"{rel}: path longer than {k.MAX_PATH_BYTES} bytes.")
        try:
            text = path.read_text("utf-8")
        except UnicodeDecodeError:
            warnings.append(f"{rel}: binary file; the browser editor keeps it but cannot edit it.")
            continue
        for n, line in enumerate(text.splitlines(), 1):
            for category in sorted(k.scan_line(line)):
                flags.append(f"{rel}:{n}: {category}: {line.strip()[:100]}")
        if rel.parts[0] == "scripts" and text.startswith("#!") and rel.suffix not in (".py", ".sh"):
            warnings.append(f"{rel}: scripts are not executable in Kobe; run it through an interpreter.")
    if total > k.MAX_UNCOMPRESSED_BYTES:
        errors.append(f"{total} bytes in all; the limit is {k.MAX_UNCOMPRESSED_BYTES}.")


def validate(root):
    """Returns (errors, flags, warnings, files)."""
    errors, flags, warnings = [], [], []
    if not root.is_dir():
        return [f"{root} is not a folder."], flags, warnings, []
    files = bundle_files(root)
    check_skill_md(root, errors, warnings)
    check_files(root, files, errors, flags, warnings)
    return errors, flags, warnings, files


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("skill_dir", type=Path)
    root = parser.parse_args().skill_dir.resolve()
    errors, flags, warnings, files = validate(root)
    for title, items in (("ERROR", errors), ("FLAG (team-admin review)", flags), ("WARNING", warnings)):
        for item in items:
            print(f"{title}: {item}")
    print(f"{len(files)} files, {len(errors)} errors, {len(flags)} flags, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())

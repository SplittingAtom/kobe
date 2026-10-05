"""Heuristic scan for risky patterns.

python scan.py PATH [PATH ...]      scan files / directories
python scan.py --diff [BASE]        scan only the lines added in `git diff BASE` (default HEAD)
Exit status is 0 even with findings; this is an aid for a human reviewer.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

RULES = [
    ("high", "hardcoded-secret", re.compile(r"(?i)(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['\"][^'\"\s]{8,}['\"]")),
    ("high", "private-key", re.compile(r"-----BEGIN [A-Z ]*PRIV" r"ATE KEY-----")),
    ("high", "aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("high", "eval-exec", re.compile(r"\b(eval|exec)\s*\(")),
    ("high", "shell-true", re.compile(r"shell\s*=\s*True|os\.system\(|child_process\.exec\(")),
    ("medium", "sql-concat", re.compile(r"(?i)(select|insert|update|delete)\b[^\n]*(\+|%s|\$\{|f['\"])[^\n]*\b(from|into|set|where)\b")),
    ("medium", "tls-verify-off", re.compile(r"verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify")),
    ("medium", "unsafe-deserialize", re.compile(r"pickle\.loads?\(|yaml\.load\((?!.*Loader)|marshal\.loads?\(")),
    ("low", "bare-except", re.compile(r"^\s*except\s*:|catch\s*\(\s*\w*\s*\)\s*\{\s*\}")),
    ("low", "debug-leftover", re.compile(r"\bconsole\.log\(|\bdebugger\b|\bbreakpoint\(\)|^\s*print\(")),
    ("low", "todo", re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")),
]
SKIP_DIRS = {".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv", ".next"}
MAX_BYTES = 1_000_000


def scan_line(path: str, number: int, line: str) -> list[str]:
    return [
        f"{path}:{number}: [{severity}] {name}: {line.strip()[:160]}"
        for severity, name, pattern in RULES
        if pattern.search(line)
    ]


def files_under(paths: list[str]):
    for raw in paths:
        p = Path(raw)
        if p.is_file():
            yield p
        elif p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and not SKIP_DIRS & set(f.parts):
                    yield f
        else:
            print(f"{raw}: not found", file=sys.stderr)


def scan_files(paths: list[str]) -> list[str]:
    found: list[str] = []
    for f in files_under(paths):
        if f.stat().st_size > MAX_BYTES:
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable
        for n, line in enumerate(text.splitlines(), start=1):
            found += scan_line(str(f), n, line)
    return found


def scan_diff(base: str) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--unified=0", "--no-color", base, "--"],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        sys.exit(proc.stderr.strip() or "git diff failed")
    found: list[str] = []
    path, number = "?", 0
    for line in proc.stdout.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else line[4:]
        elif (m := re.match(r"@@ -\S+ \+(\d+)", line)):
            number = int(m.group(1))
        elif line.startswith("+") and not line.startswith("+++"):
            found += scan_line(path, number, line[1:])
            number += 1
    return found


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--diff", nargs="?", const="HEAD", metavar="BASE")
    args = ap.parse_args()
    if args.diff is None and not args.paths:
        ap.error("give PATH(s) or --diff")
    found = scan_diff(args.diff) if args.diff is not None else scan_files(args.paths)
    order = {"high": 0, "medium": 1, "low": 2}
    found.sort(key=lambda s: order[re.search(r"\[(\w+)\]", s).group(1)])
    print("\n".join(found) if found else "no findings")
    print(f"{len(found)} finding(s)")


if __name__ == "__main__":
    main()

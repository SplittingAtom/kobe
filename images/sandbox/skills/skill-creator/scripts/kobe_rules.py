"""Kobe's skill upload rules, mirrored for offline checks (stdlib only).

Source of truth: services/server/src/skills/{limits,skill-md}.ts (refusals) and
packages/skill-scanner/src/rules.ts (flags that send a skill to team-admin review).
"""

import re

MAX_BUNDLE_BYTES = 5 * 1024 * 1024
MAX_FILES = 200
MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_SKILL_MD_BYTES = 100 * 1024
MAX_PATH_BYTES = 240
DESCRIPTION_MAX = 1024
SKILL_NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
BUILTIN_NAMES = {"data-analysis", "charts", "docx", "pdf", "xlsx", "code-review", "skill-creator"}

# Left out of packages: test runs, caches and editor or OS clutter.
EXCLUDED_DIRS = {"evals", "__pycache__", ".git", "node_modules", ".venv", "venv"}
EXCLUDED_FILES = {".DS_Store", "Thumbs.db"}

FENCE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)

_SHELL = r"(?:ba|z|da|k)?sh"
_FETCH = r"(?:curl|wget)"
_DECODE = r"(?:atob|b64decode|base64|fromhex|unhexlify|decodeURIComponent|decompress)"

SCRIPT_RULES = [
    ("pipe-to-shell", re.compile(rf"\b{_FETCH}\b[^|\n]*\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?{_SHELL}\b")),
    ("pipe-to-shell", re.compile(rf"\b{_SHELL}\s+<\(\s*{_FETCH}\b")),
    ("pipe-to-shell", re.compile(rf"\b{_SHELL}\s+-c\s+[\"']?\$\(\s*{_FETCH}\b")),
    ("network", re.compile(rf"\b{_FETCH}\s")),
    ("network", re.compile(r"\bfetch\s*\(")),
    ("network", re.compile(
        r"\b(?:requests\.(?:get|post|put|patch|delete|head|request|Session)|urllib\.request|urlopen|httpx\.|aiohttp\.)")),
    ("network", re.compile(r"\b(?:https?\.(?:get|request)\s*\(|XMLHttpRequest|axios\b|new\s+WebSocket\s*\()")),
    ("network", re.compile(r"\bsocket\.(?:socket|create_connection)\s*\(|/dev/tcp/")),
    ("network", re.compile(r"(?:^|[\s;&|(])(?:nc|ncat|netcat)\s+-?\w")),
    ("package-install", re.compile(
        r"\b(?:pip3?|pipx|poetry|conda|mamba)\s+(?:install|add)\b|\bpip3?['\"]\s*,\s*['\"]install\b")),
    ("package-install", re.compile(r"\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b")),
    ("package-install", re.compile(
        r"\b(?:apt|apt-get|aptitude|yum|dnf|apk|brew|zypper)\s+(?:-\S+\s+)*(?:install|add)\b|\bpacman\s+-S")),
    ("package-install", re.compile(r"\b(?:gem|cargo|go)\s+install\b")),
    ("obfuscation", re.compile(
        rf"\bbase64\s+(?:-d|-D|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?(?:{_SHELL}|python3?|perl|node)\b")),
    ("obfuscation", re.compile(r"\beval\s+[\"']?\$\([^)\n]{0,200}base64")),
    ("obfuscation", re.compile(rf"\b(?:eval|exec|Function|compile)\s*\(\s*[^)\n]{{0,200}}{_DECODE}")),
    ("obfuscation", re.compile(r"(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u[0-9a-fA-F]{4}){12,}")),
]

SECRET_RULES = [
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}"),
    re.compile(r"-----BEGIN (?:[A-Z]+ )*PRIV" r"ATE KEY-----"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
]
GENERIC_SECRET = re.compile(
    r"\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth)\w*[\"']?\s*[:=]\s*[\"']([A-Za-z0-9+/_.-]{20,})[\"']", re.I)
PLACEHOLDER = re.compile(r"example|changeme|placeholder|xxxx|your[_-]|dummy|sample", re.I)
MAX_SCAN_LINE = 4096


def parse_frontmatter(text):
    """Returns (fields, error). Reads top-level `key: value` pairs, quoted or plain, and `>`/`|` blocks.

    Kobe parses the frontmatter with a full YAML parser; keep to these simple forms and it agrees.
    """
    match = FENCE.match(text.lstrip("\ufeff"))
    if not match:
        return None, "SKILL.md must start with a YAML frontmatter block between --- lines."
    fields, lines, i = {}, match.group(1).splitlines(), 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#") or line[0] in " \t-":
            continue
        key, sep, raw = line.partition(":")
        if not sep:
            return None, f"Frontmatter line is not 'key: value': {line.strip()[:60]}"
        raw = raw.strip()
        if raw in (">", "|", ">-", "|-"):
            block = []
            while i < len(lines) and (not lines[i].strip() or lines[i][0] in " \t"):
                block.append(lines[i].strip())
                i += 1
            joiner = "\n" if raw.startswith("|") else " "
            fields[key.strip()] = joiner.join(b for b in block if b).strip()
        else:
            fields[key.strip()] = _scalar(raw)
    return fields, None


def _scalar(raw):
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        return raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1].replace("''", "'")
    return raw.split(" #", 1)[0].strip()


def scan_line(line):
    """Kobe scanner categories this line would be flagged for."""
    line = line[:MAX_SCAN_LINE]
    found = {category for category, pattern in SCRIPT_RULES if pattern.search(line)}
    if any(p.search(line) for p in SECRET_RULES):
        found.add("secret")
    generic = GENERIC_SECRET.search(line)
    if generic:
        value = generic.group(1)
        if re.search(r"[A-Za-z]", value) and re.search(r"\d", value) and not PLACEHOLDER.search(value):
            found.add("secret")
    return found

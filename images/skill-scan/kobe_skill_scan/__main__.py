"""Scans one catalog skill package with Cisco skill-scanner and prints one result line (KOBE-341).

The package zip is read from --package (the Job mounts it read-only), unpacked into a private
directory under /tmp with strict checks (no absolute or parent paths, no links, bounded sizes) and
scanned with the scanner's offline analyzers only: static rules, YARA, bytecode and behavioural
dataflow. Nothing calls out: no LLM judge, no VirusTotal, no Cisco AI Defense, no OSV, and the
environment the scanner sees has no API keys (the Job holds none either, and has no network).

The one line on stdout starts with ``KOBE_EXTERNAL_SCAN `` and holds JSON: the scanner's name and
version and its findings reduced to rule, severity, category, title, file and line. Snippets and
descriptions are left out: the server shows findings to reviewers, and a finding's evidence stays
in the package they already read.
"""

import argparse
import importlib.metadata
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

MARKER = "KOBE_EXTERNAL_SCAN "
MAX_FILES = 2000
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_FINDINGS = 200
SCAN_TIMEOUT_SECONDS = 240
SEVERITIES = {"critical", "high", "medium", "low", "info"}
# Only what the scanner needs to run; never a credential (none exists in the Job anyway).
KEEP_ENV = (
    "PATH",
    "HOME",
    "XDG_CACHE_HOME",
    "PYTHONPATH",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONUNBUFFERED",
    "PYTHON_DOTENV_DISABLED",
    "LITELLM_LOCAL_MODEL_COST_MAP",
    "HF_HUB_OFFLINE",
    "DO_NOT_TRACK",
    "LANG",
)


def emit(result):
    sys.stdout.write(MARKER + json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def safe_extract(package, dest):
    """Unpacks regular files only, below dest, within the size and count bounds."""
    total = 0
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES:
            raise ValueError("too many files")
        for info in entries:
            name = info.filename
            if info.is_dir():
                continue
            # No file type at all (many zip writers) is a plain file; links and devices are not.
            kind = stat.S_IFMT(info.external_attr >> 16)
            if kind and kind != stat.S_IFREG:
                raise ValueError("not a regular file: " + name)
            parts = name.replace("\\", "/").split("/")
            if name.startswith("/") or ".." in parts or any(p == "" for p in parts):
                raise ValueError("unsafe path: " + name)
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("package too large")
            target = os.path.join(dest, *parts)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def text(value, limit):
    return value[:limit] if isinstance(value, str) else None


def reduce(report):
    findings = []
    for f in report.get("findings") or []:
        if not isinstance(f, dict):
            continue
        severity = str(f.get("severity", "")).lower()
        line = f.get("line_number")
        findings.append(
            {
                "ruleId": text(f.get("rule_id"), 120) or "unknown",
                "severity": severity if severity in SEVERITIES else "info",
                "category": text(f.get("category"), 80),
                "title": text(f.get("title"), 200) or "",
                "file": text(f.get("file_path"), 300),
                "line": line if isinstance(line, int) and line >= 0 else None,
            }
        )
    return findings[:MAX_FINDINGS], len(findings) > MAX_FINDINGS


def main():
    parser = argparse.ArgumentParser(prog="kobe_skill_scan")
    parser.add_argument("--package", required=True)
    args = parser.parse_args()
    version = importlib.metadata.version("cisco-ai-skill-scanner")
    base = {"v": 1, "scanner": "cisco-ai-skill-scanner", "version": version}
    work = tempfile.mkdtemp(prefix="scan-", dir="/tmp")
    try:
        skill = os.path.join(work, "skill")
        os.makedirs(skill)
        safe_extract(args.package, skill)
        out = os.path.join(work, "report.json")
        env = {k: os.environ[k] for k in KEEP_ENV if k in os.environ}
        done = subprocess.run(
            [
                "skill-scanner",
                "scan",
                skill,
                "--use-behavioral",
                "--format",
                "json",
                "--compact",
                "--output",
                out,
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=SCAN_TIMEOUT_SECONDS,
            check=False,
        )
        if not os.path.exists(out):
            emit({**base, "error": "scanner_failed", "exitCode": done.returncode})
            return 1
        with open(out, encoding="utf-8") as f:
            findings, truncated = reduce(json.load(f))
        emit({**base, "findings": findings, "truncated": truncated})
        return 0
    except (ValueError, zipfile.BadZipFile) as err:
        emit({**base, "error": "bad_package", "detail": str(err)[:200]})
        return 1
    except subprocess.TimeoutExpired:
        emit({**base, "error": "timeout"})
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())

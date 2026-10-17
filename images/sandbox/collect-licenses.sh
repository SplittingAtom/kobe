#!/usr/bin/env bash
# Prints the licenses bundled in an image (sandbox or orbit-eval) as a pnpm-style report
# ({license: [{name, versions, ecosystem, locations, notice?}]}) for tools/license-check. Covers
# Python distributions and npm packages (Pi, kobe-sandbox-agent, the npm CLI). `notice` holds the
# text of a NOTICE file the package ships (Apache-2.0 section 4(d)); it goes into the root NOTICE.
# Output is sorted, so the committed copy (third-party-licenses.json next to the Dockerfile) can be
# compared with a fresh one: tools/license-check `inventory image-report` (KOBE-375).
# Debian packages (git, curl, ...) are separate programs, not linked; see docs/licensing.md.
set -euo pipefail
IMAGE="${1:?usage: $0 <image>}"
docker run --rm --read-only --tmpfs /tmp --user 1000:1000 --entrypoint sh "$IMAGE" -c '
python3 - <<"PY"
import json, importlib.metadata as md, os, glob, re
CLASSIFIERS = {
  "MIT License": "MIT", "BSD License": "BSD-3-Clause", "Apache Software License": "Apache-2.0",
  "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0", "Python Software Foundation License": "Python-2.0",
  "Historical Permission Notice and Disclaimer (HPND)": "HPND", "ISC License (ISCL)": "ISC",
}
NOTICE = re.compile(r"^notice(\.(txt|md|rst))?$", re.I)
def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f: return f.read().strip()
    except OSError: return None
out = []
for d in md.distributions():
    m = d.metadata
    lic = m.get("License-Expression")
    if not lic:
        cls = [c.split(" :: ")[-1] for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]
        mapped = [CLASSIFIERS.get(c, c) for c in cls]
        lic = " OR ".join(sorted(set(mapped))) if mapped else (m.get("License") or "UNKNOWN").splitlines()[0][:60]
    notices = sorted(str(f) for f in (d.files or []) if NOTICE.match(os.path.basename(str(f))))
    notice = read(d.locate_file(notices[0])) if notices else None
    out.append(("pypi", m["Name"].lower(), m["Version"], lic, "python", notice))
for root in ["/opt/pi/node_modules", "/opt/kobe/sandbox-agent/node_modules", "/usr/local/lib/node_modules"]:
    for pj in sorted(glob.glob(root + "/**/package.json", recursive=True)):
        if "/node_modules/" not in pj.replace(root, "", 1) and pj.count("node_modules") < 1: continue
        try: p = json.load(open(pj))
        except Exception: continue
        if not p.get("name") or not p.get("version") or os.path.dirname(pj).rsplit("node_modules/",1)[-1] != p["name"]: continue
        lic = p.get("license") or (p.get("licenses") or [{}])[0].get("type") or "UNKNOWN"
        if isinstance(lic, dict): lic = lic.get("type", "UNKNOWN")
        pkg_dir = os.path.dirname(pj)
        notices = sorted(f for f in os.listdir(pkg_dir) if NOTICE.match(f))
        notice = read(os.path.join(pkg_dir, notices[0])) if notices else None
        out.append(("npm", p["name"], p["version"], lic, root[: -len("/node_modules")], notice))
entries = {}
for eco, name, ver, lic, location, notice in out:
    key = (eco, name, ver)
    if key in entries:
        if location not in entries[key]["locations"]: entries[key]["locations"].append(location)
        continue
    entry = {"name": name, "versions": [ver], "ecosystem": eco, "locations": [location], "license": lic}
    if notice: entry["notice"] = notice
    entries[key] = entry
report = {}
for key in sorted(entries):
    entry = entries[key]
    entry["locations"].sort()
    report.setdefault(entry.pop("license"), []).append(entry)
print(json.dumps(report, indent=2, sort_keys=True))
PY'

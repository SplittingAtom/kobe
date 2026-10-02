#!/usr/bin/env bash
# Prints the licenses bundled in the sandbox image as a pnpm-style report ({license: [{name,
# versions}]}) for tools/license-check. Covers Python distributions and npm packages (Pi, agent).
# Debian packages (git, curl, ...) are separate programs, not linked; see docs/licensing.md.
set -euo pipefail
IMAGE="${1:?usage: $0 <image>}"
docker run --rm --read-only --tmpfs /tmp --user 1000:1000 --entrypoint sh "$IMAGE" -c '
python3 - <<"PY"
import json, importlib.metadata as md, os, glob
CLASSIFIERS = {
  "MIT License": "MIT", "BSD License": "BSD-3-Clause", "Apache Software License": "Apache-2.0",
  "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0", "Python Software Foundation License": "Python-2.0",
  "Historical Permission Notice and Disclaimer (HPND)": "HPND", "ISC License (ISCL)": "ISC",
}
out = []
for d in md.distributions():
    m = d.metadata
    lic = m.get("License-Expression")
    if not lic:
        cls = [c.split(" :: ")[-1] for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]
        mapped = [CLASSIFIERS.get(c, c) for c in cls]
        lic = " OR ".join(sorted(set(mapped))) if mapped else (m.get("License") or "UNKNOWN").splitlines()[0][:60]
    out.append(("pypi", m["Name"].lower(), m["Version"], lic))
for root in ["/opt/pi/node_modules", "/opt/kobe/sandbox-agent/node_modules", "/usr/local/lib/node_modules"]:
    for pj in glob.glob(root + "/**/package.json", recursive=True):
        if "/node_modules/" not in pj.replace(root, "", 1) and pj.count("node_modules") < 1: continue
        try: p = json.load(open(pj))
        except Exception: continue
        if not p.get("name") or not p.get("version") or os.path.dirname(pj).rsplit("node_modules/",1)[-1] != p["name"]: continue
        lic = p.get("license") or (p.get("licenses") or [{}])[0].get("type") or "UNKNOWN"
        if isinstance(lic, dict): lic = lic.get("type", "UNKNOWN")
        out.append(("npm", p["name"], p["version"], lic))
report = {}
seen = set()
for eco, name, ver, lic in out:
    key = (name, ver)
    if key in seen: continue
    seen.add(key)
    report.setdefault(lic, []).append({"name": name, "versions": [ver]})
print(json.dumps(report))
PY'

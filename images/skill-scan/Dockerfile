# Kobe's external skill scanner image (KOBE-341, spec SK32): Cisco skill-scanner (Apache-2.0) and
# Kobe's runner, which scans one catalog package (mounted read-only at /input/package.zip) with
# the scanner's offline analyzers and prints one result line. No network, no secrets: the Job
# that runs it has no service account token, no Secret, no DNS and a deny-all NetworkPolicy.
# Build from the repository root: docker build -f images/skill-scan/Dockerfile .
# Every input is pinned (base digest, the release's hashed lock, the release wheel's hashes).
# No `# syntax=` directive (see images/sandbox/Dockerfile for why).
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016

FROM ${PYTHON_IMAGE}
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/kobe/skill-scan \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/home/.cache \
    PYTHON_DOTENV_DISABLED=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    HF_HUB_OFFLINE=1 \
    DO_NOT_TRACK=1

# Dependencies from the scanner release's hashed lock (no resolver), then the scanner's own wheel.
# pip, setuptools and wheel are removed afterwards: nothing installs at runtime. Bytecode is
# compiled now because the root is read-only (olefile's Python 2 module, never imported, excepted).
COPY images/skill-scan/requirements.txt /tmp/requirements.txt
COPY images/skill-scan/scanner-requirements.txt /tmp/scanner-requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt \
 && pip install --require-hashes --no-deps -r /tmp/scanner-requirements.txt \
 && rm /tmp/requirements.txt /tmp/scanner-requirements.txt \
 && python -m compileall -q -x 'olefile/olefile2\.py$' /usr/local/lib/python3.12/site-packages \
 && pip uninstall -y pip setuptools wheel

# Kobe's runner: root-owned and read-only.
COPY images/skill-scan/kobe_skill_scan /opt/kobe/skill-scan/kobe_skill_scan

# User 1000:1000 (numeric, for runAsNonRoot). /input holds the package (a ConfigMap). No setuid
# or setgid bits; the package managers are removed (/var/lib/dpkg/status stays for Trivy).
RUN groupadd --gid 1000 kobe \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin kobe \
 && mkdir -p /input \
 && chown -R 0:0 /opt/kobe \
 && chmod -R a-w,a+rX /opt/kobe \
 && python -m compileall -q /opt/kobe/skill-scan \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && rm -rf /usr/bin/apt* /usr/bin/dpkg* /usr/sbin/dpkg* /usr/lib/apt /var/cache/apt /var/lib/apt

# Kobe's license, NOTICE and third-party inventory (Apache-2.0 section 4, KOBE-375).
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md /usr/share/doc/kobe/
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python", "-m", "kobe_skill_scan"]
CMD ["--package", "/input/package.zip"]

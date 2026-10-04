# Kobe Orbit eval image (KOBE-92, spec 52a): runs a scenario pack against an exported Orbit agent
# with Inspect AI and writes a JSON result (attack success rate + per-scenario results).
# Build from the repository root: docker build -f images/orbit-eval/Dockerfile .
# Every input is pinned (base digest, hashed pip lock shared with ci/orbit, hashed Orbit wheel).
# No `# syntax=` directive (see images/sandbox/Dockerfile for why).
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016

FROM ${PYTHON_IMAGE}
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/kobe/orbit-eval \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/home/.cache \
    PYTHON_DOTENV_DISABLED=1

# Dependencies: Inspect AI and friends from Orbit's own uv.lock (hashes, no resolver), then Orbit
# from its release wheel. pip, setuptools and wheel are removed afterwards: nothing installs at
# runtime, and they only add CVE surface. Bytecode is compiled now because the root is read-only.
COPY ci/orbit/requirements.txt /tmp/requirements.txt
COPY images/orbit-eval/orbit-requirements.txt /tmp/orbit-requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt \
 && pip install --require-hashes --no-deps -r /tmp/orbit-requirements.txt \
 && rm /tmp/requirements.txt /tmp/orbit-requirements.txt \
 && python -m compileall -q /usr/local/lib/python3.12/site-packages \
 && pip uninstall -y pip setuptools wheel

# The runner and the default scenario pack: root-owned and read-only.
COPY images/orbit-eval/kobe_orbit_eval /opt/kobe/orbit-eval/kobe_orbit_eval
COPY images/orbit-eval/scenarios /opt/kobe/orbit-eval/scenarios

# User 1000:1000 (numeric, for runAsNonRoot). /input holds the exported YAML (and an optional
# pack), /output is where the Job mounts a volume for result.json. No setuid/setgid bits.
RUN groupadd --gid 1000 kobe \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin kobe \
 && mkdir -p /input /output \
 && chown 1000:1000 /output \
 && chown -R 0:0 /opt/kobe \
 && chmod -R a-w,a+rX /opt/kobe \
 && python -m compileall -q /opt/kobe/orbit-eval \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && rm -rf /usr/bin/apt* /usr/bin/dpkg* /usr/sbin/dpkg* /usr/lib/apt /var/cache/apt /var/lib/apt
# The package managers are removed (nothing installs at runtime). /var/lib/dpkg/status stays on
# purpose: Trivy reads it to scan the Debian packages, and deleting it would blind the CVE gate.

USER 1000:1000
WORKDIR /tmp
# Model access: KOBE_MODEL_GATEWAY_URL + KOBE_MODEL_SESSION_TOKEN (set by the Job), never a key.
ENTRYPOINT ["python", "-m", "kobe_orbit_eval"]
CMD ["--orbit-yaml", "/input/agent.yaml", "--output", "/output/result.json"]
